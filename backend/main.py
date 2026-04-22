"""
AIクラウド組版 - Kumihan API (Gemini 2.0 Flash + Vivliostyle)

POST /health             - ヘルスチェック
POST /analyze            - PDF → Gemini Vision でSpan抽出（主エンドポイント）
POST /vivliostyle-build  - HTML+CSS → Vivliostyle CLI で印刷用PDF生成
POST /rebuild            - 編集済みSpan → PDF再構築（互換レイヤー）
"""
from __future__ import annotations

import os
import base64
import re
import subprocess
import tempfile
import shutil
from collections import Counter
import json
from typing import Any, Optional
import time

import fitz  # PyMuPDF
from io import BytesIO
try:
    from PIL import Image as PILImage
except ImportError:
    PILImage = None
import google.generativeai as genai

# Set Google Cloud credentials for Vision API
import os
# In Cloud Run, credentials are mounted as a secret
# In local development, use local file if exists
if os.path.exists("/secrets/service-account-key.json"):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/secrets/service-account-key.json"
else:
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    credentials_path = os.path.join(backend_dir, "service-account-key.json")
    if os.path.exists(credentials_path):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
from fastapi import FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
try:
    from google.cloud import documentai
    from google.cloud import vision
except ImportError:
    import google.cloud.documentai_v1 as documentai
    import google.cloud.vision_v1 as vision
from google.api_core.client_options import ClientOptions

# ── YomiToku (optional): 高精度日本語OCR/レイアウト解析エンジン ──────────────
# DN_SuperBook_PDF_Converter が内部採用している Python パッケージ。
# 入ってなくても他機能は動作する（遅延import + 在否チェック）。
def _yomitoku_available() -> bool:
    try:
        import yomitoku  # noqa: F401
        return True
    except Exception:
        return False

_YOMITOKU_DLA = None  # DocumentAnalyzer のシングルトンキャッシュ

def _get_yomitoku_analyzer(lite: bool = True, device: str = "cpu"):
    """DocumentAnalyzer を初期化(遅延ロード・シングルトン)。重いので再利用必須。"""
    global _YOMITOKU_DLA
    if _YOMITOKU_DLA is not None:
        return _YOMITOKU_DLA
    from yomitoku import DocumentAnalyzer
    configs = {
        "ocr": {"text_detector": {"device": device}, "text_recognizer": {"device": device}},
        "layout_analyzer": {
            "layout_parser": {"device": device},
            "table_structure_recognizer": {"device": device},
        },
    }
    _YOMITOKU_DLA = DocumentAnalyzer(
        configs=configs,
        visualize=False,
        device=device,
        lite=lite,
    )
    return _YOMITOKU_DLA

# ── Gemini 設定 ──────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GOOGLE_AI_KEY", "")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)


# ── A-OTF 登録書体レジストリ (fonts/*.otf を唯一のソースとして動的構築) ──
# 重複定義を避けるため、ファイルシステムを走査して CSS 名に復元する。
# 例: 'A-OTF-GothicMB101Pro-Bold.otf' → 'A-OTF GothicMB101Pro-Bold'
#     'AGaramondPro-Bold.otf'         → 'AGaramondPro-Bold'
# utils.ts の REGISTERED_FONT_FAMILIES と 1:1 で一致するよう変換する。

_FONTS_DIR_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts"),
    "/app/fonts",
]


def _file_to_css_font_name(filename: str) -> str:
    """OTF ファイル名 → CSS @font-face 名 に変換する。"""
    base = filename[:-4] if filename.lower().endswith(".otf") else filename
    for prefix in ("A-OTF-", "A-CID-"):
        if base.startswith(prefix):
            return prefix.rstrip("-") + " " + base[len(prefix):]
    return base


def _load_registered_families() -> list[str]:
    for d in _FONTS_DIR_CANDIDATES:
        try:
            if not os.path.isdir(d):
                continue
            otfs = sorted(f for f in os.listdir(d) if f.lower().endswith(".otf"))
            if otfs:
                print(f"Loaded {len(otfs)} OTF families from {d}")
                return [_file_to_css_font_name(f) for f in otfs]
        except Exception as e:
            print(f"fonts dir scan error at {d}: {e}")
    print("WARNING: no fonts/*.otf directory found. Font registry is empty.")
    return []


REGISTERED_FONT_FAMILIES: list[str] = _load_registered_families()

# ── FastAPI ─────────────────────────────────────────────────────────────────
app = FastAPI(title="AIクラウド組版 - Kumihan API")

# 開発・本番両方で CORS を確実に許可
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic モデル ───────────────────────────────────────────────────────────

class VivliostyleSpan(BaseModel):
    text: str
    font_class: str = "gothic"
    font_original: str = ""
    size_pt: float = 10.0
    x_pct: float = 0.0
    y_pct: float = 0.0
    w_pct: float = 50.0
    h_pct: float = 5.0


class VivliostyleBuildRequest(BaseModel):
    spans: list[VivliostyleSpan] = []
    page_mm: list[float] = [91, 55]
    title: str = "Preview"
    bg_image_b64: Optional[str] = None
    raw_html: Optional[str] = None
    raw_css: Optional[str] = None
    save_dir_name: Optional[str] = None
    images: list[dict[str, str]] = []


# ── ヘルスチェック ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/yomitoku-status")
async def yomitoku_status():
    """YomiToku が利用可能かを返す(フロントエンドが UI 表示切替に使用)"""
    available = _yomitoku_available()
    info: dict[str, Any] = {"available": available}
    if available:
        try:
            import yomitoku  # type: ignore
            info["version"] = getattr(yomitoku, "__version__", "unknown")
        except Exception:
            info["version"] = "unknown"
    else:
        info["install_hint"] = "pip install yomitoku"
    return info


# ── Gemini Vision による非テキスト画像領域の検出 ────────────────────────────

IMAGE_REGION_DETECTION_PROMPT = """
この名刺画像を分析して、すべての「非テキスト」視覚要素（画像領域）を特定してください。

## 検出対象：
- 会社ロゴ（例: 「武蔵野」のロゴマーク、企業のシンボル）
- 人物写真・ポートレート
- 認証マーク・受賞マーク（例: 健康経営優良法人、ISO認証、ホワイト500 等の丸いアイコン）
- QRコード・バーコード
- アイコン、イラスト、装飾画像

## 検出しないもの：
- 単なるテキスト（文字だけの領域）
- 罫線、枠線
- 背景色のみの領域

## 座標系：
画像の左上が (0, 0)、右下が (100, 100) の百分率で指定します。
各領域には画像要素全体をぴったり囲むタイトなバウンディングボックスを返してください。

## 出力形式（JSON配列のみ、他のテキスト不要）：
[
  {"x_pct": 5.0, "y_pct": 8.0, "w_pct": 15.0, "h_pct": 12.0, "label": "会社ロゴ"},
  {"x_pct": 70.0, "y_pct": 5.0, "w_pct": 25.0, "h_pct": 90.0, "label": "人物写真"},
  {"x_pct": 40.0, "y_pct": 75.0, "w_pct": 8.0, "h_pct": 15.0, "label": "認証マーク"}
]

画像要素が無い場合は空配列 [] を返してください。
"""


def _detect_image_regions_gemini(png_bytes: bytes, api_key: Optional[str] = None) -> list[dict]:
    """Gemini Vision で画像（非テキスト）領域のバウンディングボックスを検出。

    戻り値: [{x_pct, y_pct, w_pct, h_pct, label}, ...] (百分率)
    """
    active_key = api_key or GEMINI_API_KEY
    if not active_key:
        return []
    try:
        genai.configure(api_key=active_key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        img_part = {
            "mime_type": "image/png",
            "data": base64.b64encode(png_bytes).decode(),
        }
        response = model.generate_content(
            [IMAGE_REGION_DETECTION_PROMPT, img_part],
            generation_config=genai.GenerationConfig(
                temperature=0.1,
                max_output_tokens=4096,
                response_mime_type="application/json",
            ),
        )
        raw = (response.text or "").strip()
        if not raw:
            return []
        data = json.loads(raw)
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        print(f"_detect_image_regions_gemini error: {e}")
        return []


# ── Gemini Vision による Span 抽出 ────────────────────────────────────────────

GEMINI_EXTRACT_PROMPT = """
あなたは印刷・DTPの専門家です。この画像からすべてのテキスト要素を正確に抽出してください。
文書は名刺、パンフレット、チラシ、請求書など様々なタイプの可能性があります。

【抽出ルール】
1. 画像内に表示されているすべてのテキストを漏れなく抽出すること
   （小さな文字、電話番号、FAX番号、メールアドレス、URL、住所、
    〒郵便番号、注記、キャプション、ページ番号なども含む）
2. 各テキスト要素の位置を画像全体を100×100として正規化した座標で正確に返すこと
3. テキストが改行で分かれている場合でも、1つの論理的なブロック
   （同じフォント・サイズで隣接するもの）は1つの要素として返すこと
4. 縦書きテキストも正確に検出し、writing_direction を "vertical" にすること
5. テーブル内のテキストは、セルごと・行ごとに分けて抽出すること

【座標の推定方法】
- x_pct: テキストブロックの左端のX座標（0=画像左端、100=画像右端）
- y_pct: テキストブロックの上端のY座標（0=画像上端、100=画像下端）
- w_pct: テキストブロックの幅（0〜100）
- h_pct: テキストブロックの高さ（0〜100）
- テキストがぴったり収まる最小の矩形として座標を推定すること
- 余白を含めず、文字の外接矩形に合わせること

【フォント分類 font_class】
- gothic: ゴシック体、サンセリフ体、角ゴシック
- mincho: 明朝体、セリフ体
- gothic_bold: 太ゴシック、ボールド体（見出し等の太字）
- light: 細字、ライト体

【フォント名候補 font_candidates の推定】
- 画像から判読できる書体の特徴（ふところ・太さ・エレメント・かなの形状・欧文のセリフ/サンセリフ）を手がかりに、最も近いと思われるモリサワ A-OTF 書体候補を **複数（最大3件、信頼度の降順）** 返すこと。
- 必ず schema の enum に含まれる書体名そのまま（スペースと大文字小文字・ハイフンを完全一致）で返すこと。
- 太さ違い（Regular/Medium/Bold/Heavy/Ultra）、明朝なら Pr6/Pro/Std の系統違い、新ゴと UD 新ゴ、GothicMB101 と ShinGo などの近い系統をあわせて候補に入れてよい。
- 各候補には 0.0〜1.0 の信頼度 confidence を付けること（1位が 0.9 なら 2位は 0.5 程度、のように差を付ける）。
- 画像品質が低く書体まで特定できない場合は空配列 [] でよい（推測で嘘を出すより空が望ましい）。

【フォントサイズ推定の目安】
- 名刺: 氏名≒12〜18pt, 会社名≒10〜14pt, 部署/役職≒8〜10pt, 住所/電話≒7〜9pt
- パンフレット: 大見出し≒16〜28pt, 小見出し≒12〜16pt, 本文≒9〜12pt, キャプション≒7〜9pt
- 一般文書: タイトル≒14〜20pt, 本文≒10〜12pt, 注記≒7〜9pt

【重要】
- 空文字のテキストは含めない
- 画像内のすべてのテキストを漏れなく抽出すること（検出漏れは不可）
- 日本語・英語・数字・記号をすべて正確に読み取ること
"""

# Gemini 構造化出力スキーマ
# 参考: https://ai.google.dev/gemini-api/docs/structured-output
#   - 固定値集合は enum で指定 (Gemini が勝手なフォント名を作るのを防ぐ)
#   - 候補の複数列挙は array + minItems/maxItems
GEMINI_SPAN_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "text": {"type": "STRING", "description": "テキスト内容"},
            "font_class": {
                "type": "STRING",
                "enum": ["gothic", "mincho", "gothic_bold", "light"],
                "description": "フォント分類",
            },
            "font_candidates": {
                "type": "ARRAY",
                "description": "推定したモリサワA-OTF書体候補。信頼度降順の最大3件。自信が無ければ空配列。",
                "maxItems": 3,
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {
                            "type": "STRING",
                            "enum": REGISTERED_FONT_FAMILIES or [""],
                            "description": "登録済 A-OTF 書体名(enumから選択)",
                        },
                        "confidence": {
                            "type": "NUMBER",
                            "minimum": 0.0,
                            "maximum": 1.0,
                            "description": "0.0-1.0 の信頼度",
                        },
                    },
                    "required": ["name", "confidence"],
                },
            },
            "size_pt": {"type": "NUMBER", "description": "推定フォントサイズ(pt)"},
            "x_pct": {"type": "NUMBER", "description": "左端X座標(0-100%)"},
            "y_pct": {"type": "NUMBER", "description": "上端Y座標(0-100%)"},
            "w_pct": {"type": "NUMBER", "description": "幅(0-100%)"},
            "h_pct": {"type": "NUMBER", "description": "高さ(0-100%)"},
            "writing_direction": {
                "type": "STRING",
                "enum": ["horizontal", "vertical"],
                "description": "組方向",
            },
        },
        "required": ["text", "font_class", "size_pt", "x_pct", "y_pct", "w_pct", "h_pct"],
    },
}


def _extract_spans_gemini(
    png_bytes: bytes,
    page_w_pt: float,
    page_h_pt: float,
    api_key: str = None,
) -> list[dict[str, Any]]:
    """Gemini 2.5 Flash で PNG → Span リストを抽出（構造化出力）"""
    active_key = api_key or GEMINI_API_KEY
    if not active_key:
        print("Error: Gemini API key is not set.")
        return []

    try:
        genai.configure(api_key=active_key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        img_part = {
            "mime_type": "image/png",
            "data": base64.b64encode(png_bytes).decode(),
        }
        response = model.generate_content(
            [GEMINI_EXTRACT_PROMPT, img_part],
            generation_config=genai.GenerationConfig(
                temperature=0.1,
                max_output_tokens=16384,
                response_mime_type="application/json",
                response_schema=GEMINI_SPAN_SCHEMA,
            ),
        )
        raw = response.text.strip()
    except Exception as e:
        print(f"Gemini API Error: {e}")
        # 2.5-flash が利用不可の場合、2.0-flash にフォールバック
        try:
            print("Falling back to gemini-2.0-flash...")
            model = genai.GenerativeModel("gemini-2.0-flash")
            img_part = {
                "mime_type": "image/png",
                "data": base64.b64encode(png_bytes).decode(),
            }
            response = model.generate_content(
                [GEMINI_EXTRACT_PROMPT, img_part],
                generation_config=genai.GenerationConfig(
                    temperature=0.1,
                    max_output_tokens=16384,
                    response_mime_type="application/json",
                    response_schema=GEMINI_SPAN_SCHEMA,
                ),
            )
            raw = response.text.strip()
        except Exception as e2:
            print(f"Gemini 2.0 fallback also failed: {e2}")
            return []

    # JSON ブロック除去（response_schema 使用時は通常不要だが安全のため）
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(
            line for line in lines
            if not line.startswith("```")
        )

    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        print(f"Gemini JSON parse error. raw={raw[:300]}")
        return []

    if not isinstance(items, list):
        print(f"Gemini returned non-list: {type(items)}")
        return []

    spans = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        if not item.get("text", "").strip():
            continue
        try:
            x_pct = float(item.get("x_pct", 0))
            y_pct = float(item.get("y_pct", 0))
            w_pct = max(0.5, float(item.get("w_pct", 20)))
            h_pct = max(0.5, float(item.get("h_pct", 5)))
            size_pt = max(4.0, float(item.get("size_pt", 10)))
        except (ValueError, TypeError):
            continue

        # 座標の妥当性チェック
        x_pct = max(0, min(99, x_pct))
        y_pct = max(0, min(99, y_pct))
        w_pct = min(100 - x_pct, w_pct)
        h_pct = min(100 - y_pct, h_pct)

        # 絶対座標 (bbox) を pt 単位で計算
        bx = (x_pct / 100) * page_w_pt
        by = (y_pct / 100) * page_h_pt
        bw = (w_pct / 100) * page_w_pt
        bh = (h_pct / 100) * page_h_pt

        # 組方向
        writing_dir = item.get("writing_direction", "horizontal")
        if writing_dir not in ("horizontal", "vertical"):
            writing_dir = "horizontal"

        # Gemini が返したフォント候補（enum 制約で登録名のみ）
        raw_cands = item.get("font_candidates") or []
        font_candidates: list[dict[str, Any]] = []
        for c in raw_cands:
            if not isinstance(c, dict):
                continue
            name = (c.get("name") or "").strip()
            if not name:
                continue
            try:
                conf = float(c.get("confidence", 0.0))
            except (TypeError, ValueError):
                conf = 0.0
            font_candidates.append({
                "source": "gemini",
                "name": name,
                "confidence": max(0.0, min(1.0, conf)),
            })
        # 信頼度降順で整列し先頭を font_original の初期値に採用
        font_candidates.sort(key=lambda c: -c["confidence"])
        font_original = font_candidates[0]["name"] if font_candidates else ""

        spans.append({
            "id": f"s_{int(time.time() * 1000)}_{i}",
            "text": item["text"].strip(),
            "font_original": font_original,
            "font_candidates": font_candidates,
            "font_class": item.get("font_class", "gothic"),
            "size_pt": round(size_pt, 1),
            "origin": [bx, by + bh],
            "bbox": [bx, by, bw, bh],
            "x_pct": round(x_pct, 2),
            "y_pct": round(y_pct, 2),
            "w_pct": round(w_pct, 2),
            "h_pct": round(h_pct, 2),
            "writing_direction": writing_dir,
        })

    print(f"Gemini extracted {len(spans)} spans")
    return spans


# ── Cloud Vision API DOCUMENT_TEXT_DETECTION (手書き日本語OCR) ────────────────
# 参考: https://cloud.google.com/vision/docs/handwriting?hl=ja
#   手書き文字を含むスキャン画像で Document AI Layout Parser より高精度。
#   ページ/ブロック/段落/単語/記号の階層を JSON で返す。

def _extract_spans_vision_document(
    png_bytes: bytes,
    page_w_pt: float,
    page_h_pt: float,
) -> list[dict[str, Any]]:
    """Cloud Vision API DOCUMENT_TEXT_DETECTION で画像から手書き含むテキストを抽出。

    Vision API は入力画像のピクセル座標系で bbox を返すので、画像サイズから % に正規化し、
    さらに page_w_pt / page_h_pt を掛けて pt 座標 (bbox/origin) に変換する。

    戻り値は _extract_spans_gemini / _extract_spans_pymupdf と同一形式。
    """
    try:
        client = vision.ImageAnnotatorClient()
    except Exception as e:
        print(f"Vision client init failed: {e}")
        return []

    # 入力画像のピクセルサイズを取得 (bbox 正規化用)
    img_w, img_h = 0, 0
    if PILImage is not None:
        try:
            with PILImage.open(BytesIO(png_bytes)) as im:
                img_w, img_h = im.size
        except Exception as e:
            print(f"Vision: PIL open failed: {e}")
    if img_w <= 0 or img_h <= 0:
        return []

    try:
        image = vision.Image(content=png_bytes)
        # 言語ヒントで日本語 OCR 精度を高める
        ctx = vision.ImageContext(language_hints=["ja", "en"])
        response = client.document_text_detection(image=image, image_context=ctx)
        if response.error.message:
            print(f"Vision DOCUMENT_TEXT_DETECTION error: {response.error.message}")
            return []
    except Exception as e:
        print(f"Vision API call failed: {e}")
        return []

    annotation = response.full_text_annotation
    if not annotation or not annotation.pages:
        return []

    spans: list[dict[str, Any]] = []
    ts = int(time.time() * 1000)
    counter = 0

    def _bbox_from_vertices(verts) -> tuple[float, float, float, float]:
        xs = [v.x for v in verts if v is not None]
        ys = [v.y for v in verts if v is not None]
        if not xs or not ys:
            return 0.0, 0.0, 0.0, 0.0
        return float(min(xs)), float(min(ys)), float(max(xs) - min(xs)), float(max(ys) - min(ys))

    def _word_text(word) -> str:
        out = []
        for sym in word.symbols:
            out.append(sym.text)
            brk = getattr(sym, "property", None)
            brk = getattr(brk, "detected_break", None) if brk else None
            if brk and brk.type_ in (
                vision.TextAnnotation.DetectedBreak.BreakType.SPACE,
                vision.TextAnnotation.DetectedBreak.BreakType.SURE_SPACE,
            ):
                out.append(" ")
            elif brk and brk.type_ in (
                vision.TextAnnotation.DetectedBreak.BreakType.LINE_BREAK,
                vision.TextAnnotation.DetectedBreak.BreakType.EOL_SURE_SPACE,
            ):
                pass  # 行末はパラグラフ単位で改行挿入
        return "".join(out)

    for page in annotation.pages:
        for block in page.blocks:
            for paragraph in block.paragraphs:
                # 段落内のテキストは単語→symbol の階層。段落丸ごと1 span にする
                para_text = "".join(_word_text(w) for w in paragraph.words).strip()
                if not para_text:
                    continue
                # 段落の bbox
                verts = paragraph.bounding_box.vertices or paragraph.bounding_box.normalized_vertices
                px, py, pw, ph = _bbox_from_vertices(verts)
                if pw <= 0 or ph <= 0:
                    continue

                # 画像ピクセル → % → pt
                x_pct = max(0.0, min(99.0, px / img_w * 100))
                y_pct = max(0.0, min(99.0, py / img_h * 100))
                w_pct = max(0.5, min(100 - x_pct, pw / img_w * 100))
                h_pct = max(0.5, min(100 - y_pct, ph / img_h * 100))

                bx = (x_pct / 100) * page_w_pt
                by = (y_pct / 100) * page_h_pt
                bw = (w_pct / 100) * page_w_pt
                bh = (h_pct / 100) * page_h_pt

                # 組方向: bbox のアスペクト比 + テキスト長で判定
                writing_dir = "vertical" if (ph > pw * 1.8 and len(para_text) >= 2) else "horizontal"

                # 信頼度 (Vision は 0.0-1.0)
                conf = float(getattr(paragraph, "confidence", 0.0) or 0.0)

                # サイズ推定: bbox の短辺から pt サイズを概算
                short_side_pt = bh if writing_dir == "horizontal" else bw
                size_pt = max(4.0, round(short_side_pt * 0.72, 1))

                spans.append({
                    "id": f"viz_{ts}_{counter}",
                    "text": para_text,
                    # Vision はフォント推定しない → font_class は中立ゴシック、候補は空
                    "font_original": "",
                    "font_candidates": [],
                    "font_class": "gothic",
                    "size_pt": size_pt,
                    "origin": [bx, by + bh],
                    "bbox": [bx, by, bw, bh],
                    "x_pct": round(x_pct, 2),
                    "y_pct": round(y_pct, 2),
                    "w_pct": round(w_pct, 2),
                    "h_pct": round(h_pct, 2),
                    "writing_direction": writing_dir,
                    "confidence": round(conf, 3),
                    "size_source": "vision",
                })
                counter += 1

    print(f"Vision DOCUMENT_TEXT_DETECTION extracted {len(spans)} spans "
          f"(image={img_w}x{img_h}px, page={page_w_pt:.1f}x{page_h_pt:.1f}pt)")
    return spans


# ── Gemini AI フォント同定 (プライマリ抽出と併走する補助パス) ─────────────────
# プライマリが PyMuPDF / DocAI / YomiToku のどれでも、Gemini API キーがあれば
# 本関数で画像から書体候補を推定し、既存スパンに font_candidates を追記する。

_AI_FONT_SCHEMA = {
    "type": "ARRAY",
    "description": "各入力テキスト(index順)に対応する書体候補の配列",
    "items": {
        "type": "OBJECT",
        "properties": {
            "index": {
                "type": "INTEGER",
                "description": "入力テキスト一覧のインデックス(0始まり)",
                "minimum": 0,
            },
            "candidates": {
                "type": "ARRAY",
                "maxItems": 3,
                "description": "信頼度降順の書体候補",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {
                            "type": "STRING",
                            "enum": REGISTERED_FONT_FAMILIES or [""],
                            "description": "登録済 A-OTF 書体名",
                        },
                        "confidence": {
                            "type": "NUMBER",
                            "minimum": 0.0,
                            "maximum": 1.0,
                        },
                    },
                    "required": ["name", "confidence"],
                },
            },
        },
        "required": ["index", "candidates"],
    },
}


def _ai_font_candidates_for_spans(
    png_bytes: bytes,
    spans: list[dict[str, Any]],
    api_key: Optional[str] = None,
) -> None:
    """画像とプライマリ抽出スパンを Gemini に渡し、各スパンに font_candidates を追記する。

    spans はインプレースで更新される。Gemini API キーが無ければ何もしない。
    """
    active_key = api_key or GEMINI_API_KEY
    if not active_key or not spans:
        return
    if not REGISTERED_FONT_FAMILIES:
        return

    # Gemini に投げる軽量ペイロード: index + text + 中心座標
    items_for_prompt = []
    for i, s in enumerate(spans):
        txt = (s.get("text") or "").strip()
        if not txt:
            continue
        items_for_prompt.append({
            "index": i,
            "text": txt[:30],  # 長すぎるテキストは先頭のみ
            "x_pct": round(s.get("x_pct", 0), 1),
            "y_pct": round(s.get("y_pct", 0), 1),
            "w_pct": round(s.get("w_pct", 0), 1),
            "h_pct": round(s.get("h_pct", 0), 1),
        })
    if not items_for_prompt:
        return

    prompt = (
        "以下のテキスト要素それぞれについて、画像内のその位置に描かれている書体を"
        "モリサワ A-OTF 書体候補 (最大3件・信頼度降順) で推定してください。\n"
        "必ず schema の enum に含まれる書体名を使用し、index は入力の index と一致させてください。\n"
        "自信が無い要素は candidates を空配列で返してください。\n"
        "入力:\n" + json.dumps(items_for_prompt, ensure_ascii=False)
    )

    try:
        genai.configure(api_key=active_key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        img_part = {"mime_type": "image/png", "data": base64.b64encode(png_bytes).decode()}
        response = model.generate_content(
            [prompt, img_part],
            generation_config=genai.GenerationConfig(
                temperature=0.1,
                max_output_tokens=8192,
                response_mime_type="application/json",
                response_schema=_AI_FONT_SCHEMA,
            ),
        )
        raw = (response.text or "").strip()
        data = json.loads(raw)
    except Exception as e:
        print(f"AI font candidates: failed ({e})")
        return

    if not isinstance(data, list):
        return

    # 既存 font_candidates に Gemini 候補を追加 (重複排除)
    for entry in data:
        if not isinstance(entry, dict):
            continue
        try:
            idx = int(entry.get("index", -1))
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= len(spans):
            continue
        cands = entry.get("candidates") or []
        if not isinstance(cands, list):
            continue
        existing = spans[idx].get("font_candidates") or []
        names_seen = {c.get("name") for c in existing}
        for c in cands:
            if not isinstance(c, dict):
                continue
            nm = (c.get("name") or "").strip()
            if not nm or nm in names_seen:
                continue
            try:
                conf = float(c.get("confidence", 0.0))
            except (TypeError, ValueError):
                conf = 0.0
            existing.append({
                "source": "gemini",
                "name": nm,
                "confidence": max(0.0, min(1.0, conf)),
            })
            names_seen.add(nm)
        spans[idx]["font_candidates"] = existing
        # プライマリ font_original が空なら、AI 最高信頼度の候補を初期値に採用
        if not (spans[idx].get("font_original") or "").strip():
            ai_top = max(
                (c for c in existing if c.get("source") == "gemini"),
                key=lambda c: c.get("confidence", 0),
                default=None,
            )
            if ai_top:
                spans[idx]["font_original"] = ai_top["name"]
                spans[idx]["needs_font_review"] = False


# ── PyMuPDF 直接テキスト抽出（テキスト埋め込みPDF用・最高精度） ──────────────

_SUBSET_PREFIX_RE = re.compile(r"^[A-Z]{6}\+")


def _clean_pdf_font_name(raw: str) -> str:
    """PDF 埋込フォントのサブセット接頭辞(例 'ABCDEF+A-OTF-GothicMB101Pro-Bold')を除去し、
    よくあるハイフン変種 'A-OTF-Xxx' を CSS 登録名と揃う 'A-OTF Xxx' に正規化する。
    """
    if not raw:
        return ""
    name = raw.strip()
    # 'ABCDEF+' のような 6 文字大文字サブセットプレフィックスを除去
    name = _SUBSET_PREFIX_RE.sub("", name)
    # 'A-OTF-' → 'A-OTF ' / 'A-CID-' → 'A-CID '
    for prefix in ("A-OTF-", "A-CID-"):
        if name.startswith(prefix):
            name = prefix.rstrip("-") + " " + name[len(prefix):]
            break
    return name.strip()


def _extract_spans_pymupdf(page: Any) -> list[dict[str, Any]]:
    """PyMuPDF でテキスト埋め込みPDFから直接 Span 抽出（行単位）

    テキストが埋め込まれたPDFの場合、Gemini Vision や Document AI OCR よりも
    正確な位置・フォント・サイズ情報を得られる。
    """
    result_spans = []

    try:
        text_dict = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_PRESERVE_LIGATURES)
    except Exception as e:
        print(f"PyMuPDF get_text error: {e}")
        return []

    # text_dict の width/height は回転適用後のサイズ（座標系と一致）
    td_w = text_dict.get("width", 0)
    td_h = text_dict.get("height", 0)
    if td_w > 0 and td_h > 0:
        rect = fitz.Rect(0, 0, td_w, td_h)
    else:
        rect = page.rect
    if rect.width <= 0 or rect.height <= 0:
        return []

    span_counter = 0
    for block_idx, block in enumerate(text_dict.get("blocks", [])):
        if block.get("type") != 0:  # テキストブロックのみ
            continue

        for line_idx, line in enumerate(block.get("lines", [])):
            spans_in_line = [s for s in line.get("spans", []) if s.get("text", "").strip()]
            if not spans_in_line:
                continue

            # 行内のすべてのスパンをマージ
            full_text = "".join(s["text"] for s in spans_in_line)
            if not full_text.strip():
                continue

            # Union bounding box
            x0 = min(s["bbox"][0] for s in spans_in_line)
            y0 = min(s["bbox"][1] for s in spans_in_line)
            x1 = max(s["bbox"][2] for s in spans_in_line)
            y1 = max(s["bbox"][3] for s in spans_in_line)

            # 主要フォント（文字数ベース）
            font_counts: dict[tuple[str, float], int] = {}
            for s in spans_in_line:
                key = (_clean_pdf_font_name(s.get("font", "")), s.get("size", 9.0))
                font_counts[key] = font_counts.get(key, 0) + len(s.get("text", ""))
            dominant_font, dominant_size = max(font_counts, key=lambda k: font_counts[k])

            # 主要色（文字数ベース）— 完全再現用
            color_counts: dict[int, int] = {}
            for s in spans_in_line:
                c = int(s.get("color", 0))
                color_counts[c] = color_counts.get(c, 0) + len(s.get("text", ""))
            dominant_color_int = max(color_counts, key=lambda k: color_counts[k]) if color_counts else 0
            color_hex = f"#{dominant_color_int & 0xFFFFFF:06x}"

            # フォントクラス判定
            font_lower = dominant_font.lower()
            if any(k in font_lower for k in ["mincho", "ming", "明朝", "serif", "ryumin",
                                               "heitmin", "kozuka min", "IPAex明朝",
                                               "ms 明朝", "yu mincho", "hiragino min"]):
                font_class = "mincho"
            elif any(k in font_lower for k in ["bold", "heavy", "black", "w7", "w8", "w9",
                                                 "demibold", "semibold", "extrabold"]):
                font_class = "gothic_bold"
            elif any(k in font_lower for k in ["light", "thin", "ultralight", "w1", "w2",
                                                 "w3", "hairline"]):
                font_class = "light"
            else:
                font_class = "gothic"

            # 正規化座標
            x_pct = (x0 / rect.width) * 100
            y_pct = (y0 / rect.height) * 100
            w_pct = ((x1 - x0) / rect.width) * 100
            h_pct = ((y1 - y0) / rect.height) * 100

            # 縦書き検出: PyMuPDF の line["dir"] タプルを最優先
            # (ai-cloud-ja-composer の動作確認済パターン)
            # dir=(1,0) → 横書き / dir=(0,1) → 縦書き
            text_stripped = full_text.strip()
            line_dir = line.get("dir", (1, 0))
            if abs(line_dir[0]) > abs(line_dir[1]):
                writing_dir = "horizontal"
            else:
                writing_dir = "vertical"

            # フォント名の "V" 接尾辞が縦書きフォントを示す場合は上書き
            if any(k in font_lower for k in ["-v", "vert", "tate", "縦"]):
                writing_dir = "vertical"

            # PDF 直接抽出は真の埋込フォント名なので confidence = 1.0 の単独候補
            pdf_candidates = [
                {"source": "pymupdf", "name": dominant_font, "confidence": 1.0}
            ] if dominant_font else []

            result_spans.append({
                "id": f"pdf_{block_idx}_{line_idx}_{span_counter}",
                "text": text_stripped,
                "font_original": dominant_font,
                "font_candidates": pdf_candidates,
                "font_class": font_class,
                "size_pt": round(dominant_size, 1),
                "origin": [round(x0, 2), round(y1, 2)],
                "bbox": [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)],
                "x_pct": round(x_pct, 2),
                "y_pct": round(y_pct, 2),
                "w_pct": round(w_pct, 2),
                "h_pct": round(h_pct, 2),
                "writing_direction": writing_dir,
                "color_hex": color_hex,
            })
            span_counter += 1

    print(f"PyMuPDF direct extraction (raw): {len(result_spans)} spans")
    return result_spans


def _merge_context_spans(spans: list[dict[str, Any]],
                         page_w_pt: float, page_h_pt: float) -> list[dict[str, Any]]:
    """近接スパンをコンテキストベースでマージ（字間の広いテキスト統合）

    「経 営 計 画 書」のように各文字が独立したスパンになっている場合、
    同一行・同一フォントの近接スパンを1つの論理ブロックに統合する。
    """
    if not spans or len(spans) <= 1:
        return spans

    # pt座標で作業（正規化座標より正確）
    working = []
    for s in spans:
        working.append({
            **s,
            "_x0": (s["x_pct"] / 100) * page_w_pt,
            "_y0": (s["y_pct"] / 100) * page_h_pt,
            "_x1": ((s["x_pct"] + s["w_pct"]) / 100) * page_w_pt,
            "_y1": ((s["y_pct"] + s["h_pct"]) / 100) * page_h_pt,
        })

    # Y座標でソートしてから行グループ化
    working.sort(key=lambda s: (s["_y0"], s["_x0"]))

    merged = True
    iteration = 0
    while merged and iteration < 20:
        merged = False
        iteration += 1
        new_list: list[dict] = []
        used = set()

        for i in range(len(working)):
            if i in used:
                continue
            current = dict(working[i])

            for j in range(i + 1, len(working)):
                if j in used:
                    continue
                other = working[j]

                # ── 同一行判定: Y中心が近い ──
                cy1 = (current["_y0"] + current["_y1"]) / 2
                cy2 = (other["_y0"] + other["_y1"]) / 2
                h_max = max(current["_y1"] - current["_y0"],
                            other["_y1"] - other["_y0"], 1)
                if abs(cy1 - cy2) > h_max * 0.6:
                    # yが離れすぎ → 別行 → スキップ
                    # ただし、yがさらに離れたら全体breakで高速化
                    if other["_y0"] - current["_y1"] > h_max * 2:
                        break
                    continue

                # ── フォント一致 ──
                if current.get("font_class") != other.get("font_class"):
                    continue

                # ── フォントサイズ近似 (±40%) ──
                sz1 = current.get("size_pt", 9)
                sz2 = other.get("size_pt", 9)
                sz_max = max(sz1, sz2, 1)
                if abs(sz1 - sz2) / sz_max > 0.4:
                    continue

                # ── X方向の距離: 字間の広いテキストも許容 ──
                right1 = current["_x1"]
                left2 = other["_x0"]
                x_gap = left2 - right1

                # 最大許容ギャップ = フォントサイズ × 4（字間の広い文字スペーシング対応）
                max_gap = max(sz_max * 4, 30)  # 最低30pt
                if x_gap > max_gap:
                    continue
                # 逆方向の重なりも許容（最大50%）
                if x_gap < -(current["_x1"] - current["_x0"]) * 0.5:
                    continue

                # ── マージ実行 ──
                new_x0 = min(current["_x0"], other["_x0"])
                new_y0 = min(current["_y0"], other["_y0"])
                new_x1 = max(current["_x1"], other["_x1"])
                new_y1 = max(current["_y1"], other["_y1"])

                # テキスト結合（X順序で）
                if other["_x0"] >= current["_x0"]:
                    merged_text = current["text"] + other["text"]
                else:
                    merged_text = other["text"] + current["text"]

                current["text"] = merged_text
                current["_x0"] = new_x0
                current["_y0"] = new_y0
                current["_x1"] = new_x1
                current["_y1"] = new_y1
                current["size_pt"] = round(max(sz1, sz2), 1)

                # font_original: 最初のものを保持
                if not current.get("font_original") and other.get("font_original"):
                    current["font_original"] = other["font_original"]

                used.add(j)
                merged = True

            # 正規化座標を再計算
            current["x_pct"] = round((current["_x0"] / page_w_pt) * 100, 2)
            current["y_pct"] = round((current["_y0"] / page_h_pt) * 100, 2)
            current["w_pct"] = round(((current["_x1"] - current["_x0"]) / page_w_pt) * 100, 2)
            current["h_pct"] = round(((current["_y1"] - current["_y0"]) / page_h_pt) * 100, 2)
            current["origin"] = [round(current["_x0"], 2), round(current["_y1"], 2)]
            current["bbox"] = [round(current["_x0"], 2), round(current["_y0"], 2),
                               round(current["_x1"] - current["_x0"], 2),
                               round(current["_y1"] - current["_y0"], 2)]

            new_list.append(current)

        working = sorted(new_list, key=lambda s: (s["_y0"], s["_x0"]))

    # 内部ワーク用キーを除去 & ID再割り当て
    result = []
    for idx, s in enumerate(working):
        s.pop("_x0", None)
        s.pop("_y0", None)
        s.pop("_x1", None)
        s.pop("_y1", None)
        s["id"] = f"ctx_{idx}"
        result.append(s)

    print(f"Context merge: {len(spans)} → {len(result)} spans")
    return result


def _merge_font_info(docai_spans: list[dict], pymupdf_spans: list[dict],
                     page_w: float, page_h: float):
    """Document AIのspan に PyMuPDF の正確なフォント情報（名前・サイズ・クラス）をマージ"""
    for ds in docai_spans:
        dx_center = ds["x_pct"] + ds["w_pct"] / 2
        dy_center = ds["y_pct"] + ds["h_pct"] / 2

        best_match = None
        best_dist = 999999
        for ps in pymupdf_spans:
            px_center = ps["x_pct"] + ps["w_pct"] / 2
            py_center = ps["y_pct"] + ps["h_pct"] / 2
            dist = abs(dx_center - px_center) + abs(dy_center - py_center)
            # テキストの一致度も考慮
            text_overlap = _text_similarity(ds.get("text", ""), ps.get("text", ""))
            if text_overlap > 0.3:
                dist *= (1.0 - text_overlap * 0.5)
            if dist < best_dist:
                best_dist = dist
                best_match = ps

        if best_match and best_dist < 15:  # 近い位置にマッチするspanがある場合
            ds["font_class"] = best_match.get("font_class", ds.get("font_class", "gothic"))
            ds["size_pt"] = best_match.get("size_pt", ds.get("size_pt", 9.0))
            if "font_original" in best_match:
                ds["font_original"] = best_match["font_original"]
            if "writing_direction" in best_match:
                ds["writing_direction"] = best_match["writing_direction"]
            # font_candidates は既存 (DocAI 由来) に PyMuPDF 由来を追加し、
            # source 付きで全エンジンの結果をユーザーに見せられる形で残す
            existing = ds.get("font_candidates") or []
            extra = best_match.get("font_candidates") or []
            names_seen = {c.get("name") for c in existing}
            for c in extra:
                if c.get("name") and c.get("name") not in names_seen:
                    existing.append(c)
                    names_seen.add(c.get("name"))
            ds["font_candidates"] = existing


def _text_similarity(a: str, b: str) -> float:
    """2つのテキストの簡易類似度（0.0〜1.0）"""
    if not a or not b:
        return 0.0
    a, b = a.strip(), b.strip()
    if a == b:
        return 1.0
    shorter = min(len(a), len(b))
    longer = max(len(a), len(b))
    if longer == 0:
        return 0.0
    common = sum(1 for ca, cb in zip(a, b) if ca == cb)
    return common / longer


# ── 回転補正ヘルパ ─────────────────────────
# Document AI の normalized_vertices は回転前(mediabox)基準。
# PyMuPDF の get_pixmap() は回転適用後のピクセルを返すため、
# 表示PNG/rebuild時の eff_rect と一致させるには rotation 分の座標変換が必要。

def _rotate_bbox_pct(x_pct: float, y_pct: float,
                     w_pct: float, h_pct: float,
                     rotation: int) -> tuple[float, float, float, float]:
    """pct座標(0-100)を rotation度(時計回り)回転後の座標系に変換。
    PDFページの回転方向(PyMuPDF page.rotation)に合わせる。
    軸スワップ(90/270)時は w と h も入れ替える。
    """
    r = rotation % 360
    if r == 0:
        return x_pct, y_pct, w_pct, h_pct
    if r == 90:
        # 時計回り90°: (x,y) → (100-y-h, x), 軸スワップ
        return (100 - y_pct - h_pct), x_pct, h_pct, w_pct
    if r == 180:
        return (100 - x_pct - w_pct), (100 - y_pct - h_pct), w_pct, h_pct
    if r == 270:
        # 時計回り270° = 反時計回り90°: (x,y) → (y, 100-x-w), 軸スワップ
        return y_pct, (100 - x_pct - w_pct), h_pct, w_pct
    return x_pct, y_pct, w_pct, h_pct


def _apply_rotation_to_spans(items: list[dict[str, Any]], rotation: int) -> None:
    """list中の各dictの x_pct/y_pct/w_pct/h_pct を rotation適用後に書き換え（in-place）。
    writing_direction も 90/270 時に horizontal↔vertical をスワップ。
    """
    if rotation % 360 == 0:
        return
    r = rotation % 360
    for it in items:
        if all(k in it for k in ("x_pct", "y_pct", "w_pct", "h_pct")):
            it["x_pct"], it["y_pct"], it["w_pct"], it["h_pct"] = _rotate_bbox_pct(
                it["x_pct"], it["y_pct"], it["w_pct"], it["h_pct"], r
            )
        if r in (90, 270) and it.get("writing_direction"):
            it["writing_direction"] = (
                "vertical" if it["writing_direction"] == "horizontal" else "horizontal"
            )


# ── Document AI による Span 抽出 ─────────────────────────

def _extract_spans_documentai(pdf_bytes: bytes,
                              project_id: str,
                              location: str,
                              processor_id: str,
                              version_id: Optional[str] = None) -> list[dict[str, Any]]:
    """Document AI で PDF 全体から Span + レイアウト情報を抽出 (チャンク処理対応)

    Returns: list of dicts per page:
        {
            "spans": [...],
            "layout_blocks": [...],   # 画像/テーブル/テキストブロック
            "barcodes": [...],
            "detected_languages": [...],
        }
    """
    opts = ClientOptions(api_endpoint=f"{location}-documentai.googleapis.com")
    client = documentai.DocumentProcessorServiceClient(client_options=opts)

    if version_id:
        name = client.processor_version_path(
            project_id, location, processor_id, version_id)
    else:
        name = client.processor_path(project_id, location, processor_id)

    # チャンク分割 (15ページ単位)
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    total_pages = len(doc)
    chunk_size = 15

    all_pages_data: list[dict[str, Any]] = []

    for start_idx in range(0, total_pages, chunk_size):
        end_idx = min(start_idx + chunk_size, total_pages)
        # サブドキュメントの作成
        doc_chunk = fitz.open()
        doc_chunk.insert_pdf(doc, from_page=start_idx, to_page=end_idx - 1)
        chunk_pdf_bytes = doc_chunk.write()
        doc_chunk.close()

        raw_document = documentai.RawDocument(
            content=chunk_pdf_bytes, mime_type="application/pdf"
        )
        request = documentai.ProcessRequest(
            name=name,
            raw_document=raw_document
        )

        try:
            result = client.process_document(request=request)
            document = result.document
        except Exception as e:
            print(f"Document AI API Error: {e}")
            for _ in range(end_idx - start_idx):
                all_pages_data.append({"spans": [], "layout_blocks": [], "barcodes": [], "detected_languages": []})
            continue

        # ── token → フォントスタイルマップ構築 ──
        # Document AI の style 情報からフォントサイズ・ファミリー・ウェイトを取得
        font_size_map: dict[str, float] = {}
        font_family_map: dict[str, str] = {}
        font_weight_map: dict[str, str] = {}
        try:
            for style in getattr(document, "text_styles", []):
                fs = getattr(style, "font_size", None)
                family = getattr(style, "font_family", "")
                weight = getattr(style, "font_weight", "")
                for seg in style.text_anchor.text_segments:
                    start = int(seg.start_index) if seg.start_index else 0
                    end = int(seg.end_index) if seg.end_index else 0
                    for idx in range(start, end):
                        sid = str(idx)
                        if fs:
                            size_pt = getattr(fs, "size", 0)
                            unit = getattr(fs, "unit", "")
                            if (unit == "PT" or not unit) and size_pt:
                                font_size_map[sid] = size_pt
                        if family:
                            font_family_map[sid] = _clean_pdf_font_name(family)
                        if weight:
                            font_weight_map[sid] = str(weight)
        except Exception:
            pass

        for page in document.pages:
            page_spans = []
            page_blocks = []
            page_barcodes = []
            page_langs = []

            # ── テキスト行抽出 ──
            for i, line in enumerate(page.lines):
                text = ""
                char_indices = []
                for segment in line.layout.text_anchor.text_segments:
                    try:
                        start = int(segment.start_index) if segment.start_index else 0
                    except (AttributeError, ValueError, TypeError):
                        start = 0
                    try:
                        end = int(segment.end_index) if segment.end_index else 0
                    except (AttributeError, ValueError, TypeError):
                        end = 0
                    text += document.text[start:end]
                    char_indices.extend(range(start, end))

                if not text.strip():
                    continue

                # フォントファミリー取得 (Document AI text_styles から)
                font_original = ""
                if char_indices and font_family_map:
                    families = [font_family_map[str(idx)] for idx in char_indices if str(idx) in font_family_map]
                    if families:
                        # 最頻出ファミリーを採用
                        font_original = Counter(families).most_common(1)[0][0]

                # フォントウェイト取得
                detected_weight = ""
                if char_indices and font_weight_map:
                    weights = [font_weight_map[str(idx)] for idx in char_indices if str(idx) in font_weight_map]
                    if weights:
                        detected_weight = Counter(weights).most_common(1)[0][0]

                # フォントクラス推定（font_original + weight ベース）
                fo_lower = font_original.lower()
                if any(k in fo_lower for k in ["mincho", "ming", "明朝", "serif", "ryumin",
                                                 "kozuka min", "hiragino min", "yu mincho"]):
                    font_class = "mincho"
                elif detected_weight and int(float(detected_weight)) >= 600:
                    font_class = "gothic_bold"
                elif detected_weight and int(float(detected_weight)) <= 300:
                    font_class = "light"
                else:
                    font_class = "gothic"
                # style_info フォールバック
                if not font_original and hasattr(line, "style_info") and line.style_info:
                    font_original = getattr(line.style_info, "font_family", "")
                    if "mincho" in font_original.lower() or "serif" in font_original.lower():
                        font_class = "mincho"

                # フォントサイズ推定 (Document AI style から)
                size_pt = 9.0
                if char_indices and font_size_map:
                    sizes = [font_size_map[str(idx)] for idx in char_indices if str(idx) in font_size_map]
                    if sizes:
                        size_pt = round(sum(sizes) / len(sizes), 1)

                v = line.layout.bounding_poly.normalized_vertices
                if len(v) < 4:
                    continue

                x_min = min(v[0].x, v[1].x, v[2].x, v[3].x)
                y_min = min(v[0].y, v[1].y, v[2].y, v[3].y)
                x_max = max(v[0].x, v[1].x, v[2].x, v[3].x)
                y_max = max(v[0].y, v[1].y, v[2].y, v[3].y)

                # ── 縦書き検出（優先順位） ──
                # 1. Document AI の line.layout.orientation（公式情報）
                #    PAGE_UP=1(横書き) / PAGE_RIGHT=2 / PAGE_DOWN=3 / PAGE_LEFT=4(縦書き一般)
                # 2. フォント名の "-V" 等の縦書き書体指定
                # 3. bbox 縦長 (h > w*1.2 かつ 2文字以上)
                bb_w = x_max - x_min
                bb_h = y_max - y_min
                writing_dir = "horizontal"
                orientation = getattr(line.layout, "orientation", None)
                if orientation is not None:
                    # enum int値: PAGE_RIGHT(2), PAGE_LEFT(4) を縦書きと判定
                    try:
                        ori_val = int(orientation)
                    except Exception:
                        ori_val = 0
                    if ori_val in (2, 3, 4):
                        writing_dir = "vertical"
                # フォント名ヒント
                if any(k in fo_lower for k in ["-v", "vert", "tate", "縦"]):
                    writing_dir = "vertical"
                # bbox アスペクト比（しきい値を緩和: 1.2倍）
                if writing_dir == "horizontal" and bb_h > bb_w * 1.2 and len(text.strip()) > 1:
                    writing_dir = "vertical"

                docai_candidates = (
                    [{"source": "docai", "name": font_original, "confidence": 0.8}]
                    if font_original else []
                )

                page_spans.append({
                    "id": f"dai_{int(time.time() * 1000)}_{i}",
                    "text": text.strip(),
                    "font_original": font_original,
                    "font_candidates": docai_candidates,
                    "font_class": font_class,
                    "size_pt": size_pt,
                    "x_pct": x_min * 100,
                    "y_pct": y_min * 100,
                    "w_pct": (x_max - x_min) * 100,
                    "h_pct": (y_max - y_min) * 100,
                    "writing_direction": writing_dir,
                })

            # ── レイアウトブロック (画像/テーブル/テキスト領域) ──
            for bi, block in enumerate(page.blocks):
                v = block.layout.bounding_poly.normalized_vertices
                if len(v) < 4:
                    continue
                x_min = min(vv.x for vv in v)
                y_min = min(vv.y for vv in v)
                x_max = max(vv.x for vv in v)
                y_max = max(vv.y for vv in v)

                # ブロックのテキストを取得してタイプ判定
                block_text = ""
                for segment in block.layout.text_anchor.text_segments:
                    try:
                        start = int(segment.start_index) if segment.start_index else 0
                        end = int(segment.end_index) if segment.end_index else 0
                        block_text += document.text[start:end]
                    except Exception:
                        pass

                # テキストがなければ画像ブロックと推定
                block_type = "text" if block_text.strip() else "image"

                page_blocks.append({
                    "id": f"block_{bi}",
                    "type": block_type,
                    "x_pct": x_min * 100,
                    "y_pct": y_min * 100,
                    "w_pct": (x_max - x_min) * 100,
                    "h_pct": (y_max - y_min) * 100,
                    "confidence": getattr(block.layout, "confidence", 0),
                    "text_preview": block_text.strip()[:50] if block_text.strip() else None,
                })

            # ── テーブル検出 ──
            for ti, table in enumerate(getattr(page, "tables", [])):
                v = table.layout.bounding_poly.normalized_vertices
                if len(v) < 4:
                    continue
                x_min = min(vv.x for vv in v)
                y_min = min(vv.y for vv in v)
                x_max = max(vv.x for vv in v)
                y_max = max(vv.y for vv in v)
                page_blocks.append({
                    "id": f"table_{ti}",
                    "type": "table",
                    "x_pct": x_min * 100,
                    "y_pct": y_min * 100,
                    "w_pct": (x_max - x_min) * 100,
                    "h_pct": (y_max - y_min) * 100,
                    "rows": len(table.header_rows) + len(table.body_rows) if hasattr(table, "body_rows") else 0,
                    "confidence": getattr(table.layout, "confidence", 0),
                })

            # ── バーコード検出 ──
            for bci, barcode in enumerate(getattr(page, "detected_barcodes", [])):
                v = barcode.layout.bounding_poly.normalized_vertices
                bc_data = {
                    "id": f"barcode_{bci}",
                    "type": "barcode",
                    "format": getattr(barcode.barcode, "format_", "UNKNOWN") if hasattr(barcode, "barcode") else "UNKNOWN",
                    "value": getattr(barcode.barcode, "raw_value", "") if hasattr(barcode, "barcode") else "",
                }
                if len(v) >= 4:
                    x_min = min(vv.x for vv in v)
                    y_min = min(vv.y for vv in v)
                    x_max = max(vv.x for vv in v)
                    y_max = max(vv.y for vv in v)
                    bc_data.update({
                        "x_pct": x_min * 100,
                        "y_pct": y_min * 100,
                        "w_pct": (x_max - x_min) * 100,
                        "h_pct": (y_max - y_min) * 100,
                    })
                page_barcodes.append(bc_data)

            # ── 言語検出 ──
            for lang in getattr(page, "detected_languages", []):
                page_langs.append({
                    "code": getattr(lang, "language_code", "unknown"),
                    "confidence": getattr(lang, "confidence", 0),
                })

            all_pages_data.append({
                "spans": page_spans,
                "layout_blocks": page_blocks,
                "barcodes": page_barcodes,
                "detected_languages": page_langs,
            })

    doc.close()
    return all_pages_data


# ── YomiToku による Span 抽出 ─────────────────────────
# DN_SuperBook_PDF_Converter が内部採用する高精度日本語OCRエンジン。
# 縦書き・手書き・7000+文字対応、レイアウト解析・表構造・読み順推定付き。

def _extract_spans_yomitoku(pdf_bytes: bytes,
                            lite: bool = True,
                            device: str = "cpu") -> list[dict[str, Any]]:
    """YomiToku で PDF 全体から Span + レイアウト情報を抽出。

    各ページを画像に変換 → DocumentAnalyzer で解析 → /analyze と同じ
    dict 形式(spans/layout_blocks/barcodes/detected_languages)で返す。
    座標系は画像(=PNG=eff_rect=回転後)の pct。追加の回転補正は不要。
    """
    if not _yomitoku_available():
        raise HTTPException(503, "YomiToku が未インストールです (pip install yomitoku)")

    import numpy as np
    analyzer = _get_yomitoku_analyzer(lite=lite, device=device)

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    all_pages: list[dict[str, Any]] = []

    for pi in range(len(doc)):
        page = doc.load_page(pi)
        long_side_pt = max(page.rect.width, page.rect.height)
        scale = max(2.0, min(6.0, 2400 / long_side_pt))
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        img_w, img_h = pix.width, pix.height
        # RGB numpy 配列 (YomiToku は BGR を期待 → 変換)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(img_h, img_w, pix.n)
        if pix.n == 4:
            arr = arr[:, :, :3]
        bgr = arr[:, :, ::-1].copy()

        try:
            result, _ovis, _tvis = analyzer(bgr)
        except Exception as e:
            print(f"YomiToku page {pi} failed: {e}")
            all_pages.append({"spans": [], "layout_blocks": [], "barcodes": [], "detected_languages": []})
            continue

        # ── OCR 結果 → spans (words / paragraphs 単位) ──
        spans: list[dict[str, Any]] = []
        ts = int(time.time() * 1000)
        # paragraphs が豊かなら paragraph 単位、そうでなければ words 単位
        paragraphs = getattr(result, "paragraphs", None) or []
        words = getattr(result, "words", None) or []

        def _rect_from(points) -> tuple[float, float, float, float]:
            xs = [p[0] for p in points] if points else [0, 0]
            ys = [p[1] for p in points] if points else [0, 0]
            return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)

        source_items = paragraphs if paragraphs else words
        for i, item in enumerate(source_items):
            text = (getattr(item, "contents", None)
                    or getattr(item, "content", None)
                    or "")
            text = (text or "").strip()
            if not text:
                continue
            # YomiToku の座標は画像ピクセル。bbox or points を許容
            box = getattr(item, "box", None) or getattr(item, "points", None)
            if box and hasattr(box, "__len__") and len(box) == 4 and not hasattr(box[0], "__len__"):
                # [x1, y1, x2, y2]
                x0, y0, x1, y1 = box
                bx, by, bw, bh = x0, y0, (x1 - x0), (y1 - y0)
            elif box:
                bx, by, bw, bh = _rect_from(box)
            else:
                continue
            if bw <= 0 or bh <= 0:
                continue
            direction = getattr(item, "direction", None) or "horizontal"
            if direction not in ("horizontal", "vertical"):
                direction = "vertical" if bh > bw * 1.8 else "horizontal"
            est_size_pt = max(4.0, round((bh if direction == "horizontal" else bw) / scale * 0.72, 1))
            spans.append({
                "id": f"yt_{ts}_{i}",
                "text": text,
                # YomiToku 自体はフォント名を返さないので空にする (フロントは font_class で描画)
                "font_original": "",
                "font_class": "mincho" if "mincho" in text.lower() else "gothic",
                "size_pt": est_size_pt,
                "x_pct": bx / img_w * 100,
                "y_pct": by / img_h * 100,
                "w_pct": bw / img_w * 100,
                "h_pct": bh / img_h * 100,
                "writing_direction": direction,
            })

        # ── figures → layout_blocks (image) ──
        layout_blocks: list[dict[str, Any]] = []
        figures = getattr(result, "figures", None) or []
        for fi, fig in enumerate(figures):
            box = getattr(fig, "box", None) or getattr(fig, "points", None)
            if not box:
                continue
            if len(box) == 4 and not hasattr(box[0], "__len__"):
                x0, y0, x1, y1 = box
                bx, by, bw, bh = x0, y0, (x1 - x0), (y1 - y0)
            else:
                bx, by, bw, bh = _rect_from(box)
            if bw <= 0 or bh <= 0:
                continue
            layout_blocks.append({
                "id": f"yt_fig_{fi}",
                "type": "image",
                "x_pct": bx / img_w * 100,
                "y_pct": by / img_h * 100,
                "w_pct": bw / img_w * 100,
                "h_pct": bh / img_h * 100,
                "confidence": getattr(fig, "score", 0) or 0,
                "text_preview": None,
            })

        # ── tables → layout_blocks (table) ──
        tables = getattr(result, "tables", None) or []
        for ti, tbl in enumerate(tables):
            box = getattr(tbl, "box", None) or getattr(tbl, "points", None)
            if not box:
                continue
            if len(box) == 4 and not hasattr(box[0], "__len__"):
                x0, y0, x1, y1 = box
                bx, by, bw, bh = x0, y0, (x1 - x0), (y1 - y0)
            else:
                bx, by, bw, bh = _rect_from(box)
            if bw <= 0 or bh <= 0:
                continue
            layout_blocks.append({
                "id": f"yt_tbl_{ti}",
                "type": "table",
                "x_pct": bx / img_w * 100,
                "y_pct": by / img_h * 100,
                "w_pct": bw / img_w * 100,
                "h_pct": bh / img_h * 100,
                "rows": len(getattr(tbl, "cells", []) or []),
                "confidence": getattr(tbl, "score", 0) or 0,
            })

        all_pages.append({
            "spans": spans,
            "layout_blocks": layout_blocks,
            "barcodes": [],
            "detected_languages": [{"code": "ja", "confidence": 1.0}],
        })
        print(f"YomiToku page {pi}: {len(spans)} spans, {len(layout_blocks)} blocks")

    doc.close()
    return all_pages


# ── /analyze エンドポイント ────────────────────────────────────────────────────

@app.post("/analyze")
async def analyze_pdf(
    file: UploadFile = File(...),
    x_gemini_api_key: Optional[str] = Header(None),
    x_use_documentai: Optional[str] = Header(None),
    x_project_id: Optional[str] = Header(None),
    x_location: Optional[str] = Header(None),
    x_processor_id: Optional[str] = Header(None),
    x_version_id: Optional[str] = Header(None),
    x_use_yomitoku: Optional[str] = Header(None),
    x_yomitoku_lite: Optional[str] = Header(None),
    x_yomitoku_device: Optional[str] = Header(None),
    x_use_vision_ocr: Optional[str] = Header(None),
):
    """PDF → Gemini / Document AI / YomiToku / Vision OCR のいずれかでSpan抽出"""
    ct = (file.content_type or "").lower()
    fn = (file.filename or "").lower()
    is_pdf = ("pdf" in ct) or fn.endswith(".pdf")
    if not is_pdf:
        raise HTTPException(
            400, "PDFファイルのみ対応しています"
        )

    try:
        pdf_bytes = await file.read()
        pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        pages_data = []

        # PDF内にテキスト情報が埋め込まれているかチェック
        has_text = False
        for i in range(len(pdf_doc)):
            if pdf_doc.load_page(i).get_text("text").strip():
                has_text = True
                break

        # モード選択: YomiToku > Vision OCR > Document AI > Gemini
        # Vision OCR は手書き日本語に強いので、明示指定 or DocAI が空返却時の自動フォールバックに使う
        use_yomitoku = (x_use_yomitoku or "").lower() == "true"
        use_vision_ocr = (x_use_vision_ocr or "").lower() == "true"
        use_docai_mode = (x_use_documentai or "").lower()
        use_docai = (use_docai_mode != "false") and not use_yomitoku and not use_vision_ocr

        # YomiToku 抽出（使用時は他エンジンをスキップ）
        yomitoku_results: list[dict[str, Any]] = []
        if use_yomitoku:
            lite = (x_yomitoku_lite or "true").lower() != "false"
            device = (x_yomitoku_device or "cpu").lower()
            print(f"Using YomiToku (lite={lite}, device={device})...")
            try:
                yomitoku_results = _extract_spans_yomitoku(pdf_bytes, lite=lite, device=device)
                print(f"YomiToku extracted {len(yomitoku_results)} pages")
            except HTTPException:
                raise
            except Exception as yt_err:
                print(f"YomiToku failed, falling back to other engines: {yt_err}")
                yomitoku_results = []
                use_yomitoku = False
                use_docai = (use_docai_mode != "false")

        docai_results: list[dict[str, Any]] = []
        if use_docai:
            prj = x_project_id or os.environ.get("VITE_GOOGLE_PROJECT_ID", "270124753853")
            loc = x_location or os.environ.get("VITE_DOCUMENT_AI_LOCATION", "us")
            proc = x_processor_id or os.environ.get("VITE_DOCUMENT_AI_PROCESSOR_ID", "57695b373b653f96")
            ver = x_version_id or os.environ.get("VITE_DOCUMENT_AI_VERSION_ID")
            print(f"Using Document AI (always-on) ({prj}, {loc}, {proc})...")
            try:
                docai_results = _extract_spans_documentai(
                    pdf_bytes, prj, loc, proc, ver)
                print(f"Document AI extracted {len(docai_results)} pages")
            except Exception as docai_err:
                print(f"Document AI failed, falling back: {docai_err}")
                docai_results = []

        for i in range(len(pdf_doc)):
            page = pdf_doc.load_page(i)
            raw_rect = page.rect

            # 適応的スケーリング: 高品質プレビュー用
            long_side_pt = max(raw_rect.width, raw_rect.height)
            min_target_px = 3000
            scale_factor = max(3, min_target_px / long_side_pt)
            scale_factor = min(scale_factor, 8)  # 上限8倍
            pix = page.get_pixmap(matrix=fitz.Matrix(scale_factor, scale_factor))
            png_bytes = pix.tobytes("png")
            original_png_b64 = base64.b64encode(png_bytes).decode("utf-8")

            # ★ pixmap の実ピクセルから実効ページサイズを逆算（rotation 安全）
            # get_pixmap() は常に回転適用後のピクセルを返すため、
            # これを scale_factor で割れば回転適用後の pt 寸法が得られる
            eff_width = pix.width / scale_factor
            eff_height = pix.height / scale_factor
            rect = fitz.Rect(0, 0, eff_width, eff_height)
            width_mm = eff_width * 0.352778
            height_mm = eff_height * 0.352778

            print(f"Page {i}: raw={raw_rect.width:.0f}x{raw_rect.height:.0f}pt "
                  f"rotation={page.rotation}° → eff={eff_width:.1f}x{eff_height:.1f}pt "
                  f"({width_mm:.1f}x{height_mm:.1f}mm) → "
                  f"{pix.width}x{pix.height}px (scale={scale_factor:.1f}x)")

            # Document AI / YomiToku レイアウト情報
            docai_layout_blocks = []
            docai_barcodes = []
            docai_languages = []

            if use_yomitoku and i < len(yomitoku_results):
                # YomiToku 結果を主軸に使用（座標は画像=回転後基準のため回転補正不要）
                yt_page = yomitoku_results[i]
                spans = yt_page["spans"]
                docai_layout_blocks = yt_page.get("layout_blocks", [])
                docai_languages = yt_page.get("detected_languages", [])
                for s in spans:
                    bx = (s["x_pct"] / 100) * rect.width
                    by = (s["y_pct"] / 100) * rect.height
                    bw = (s["w_pct"] / 100) * rect.width
                    bh = (s["h_pct"] / 100) * rect.height
                    s.update({"origin": [bx, by + bh], "bbox": [bx, by, bw, bh]})
                # テキスト埋め込みPDFがあればフォント情報だけ PyMuPDF から補強
                if has_text:
                    pymupdf_spans = _extract_spans_pymupdf(page)
                    if pymupdf_spans:
                        _merge_font_info(spans, pymupdf_spans, rect.width, rect.height)
                print(f"Page {i}: YomiToku → {len(spans)} spans")
            elif use_docai and i < len(docai_results):
                # Document AI 結果を主軸に使用
                docai_page = docai_results[i]
                spans = docai_page["spans"]
                docai_layout_blocks = docai_page.get("layout_blocks", [])
                docai_barcodes = docai_page.get("barcodes", [])
                docai_languages = docai_page.get("detected_languages", [])
                # ★ ページ回転に応じて pct 座標を回転後フレームへ変換
                # (Document AI は mediabox 基準、表示PNG/eff_rect は回転適用後)
                rot = int(getattr(page, "rotation", 0) or 0)
                if rot % 360 != 0:
                    print(f"Page {i}: applying rotation {rot}° to DocumentAI spans/blocks/barcodes")
                    _apply_rotation_to_spans(spans, rot)
                    _apply_rotation_to_spans(docai_layout_blocks, rot)
                    _apply_rotation_to_spans(docai_barcodes, rot)
                # 座標を pt に変換 + サイズ/フォントのフォールバック計算
                for s in spans:
                    bx = (s["x_pct"] / 100) * rect.width
                    by = (s["y_pct"] / 100) * rect.height
                    bw = (s["w_pct"] / 100) * rect.width
                    bh = (s["h_pct"] / 100) * rect.height
                    s.update({
                        "origin": [bx, by + bh],
                        "bbox": [bx, by, bw, bh],
                    })
                    # ★ size_pt フォールバック: DocumentAI が font_size を返さなかった時は
                    #   bbox 高さから逆算する (縦書きは幅ベース)。公式: pt = height_pt * 0.72
                    #   (大文字高 ≒ fontSize * 0.72、日本語は近似値)
                    if s.get("size_pt", 0) <= 9.01:  # デフォルト 9.0 のまま=DocAI未返却
                        dim = bw if s.get("writing_direction") == "vertical" else bh
                        if dim > 0:
                            est = round(dim * 0.8, 1)  # 漢字は full-em なので 0.8 係数
                            if 4.0 <= est <= 200.0:
                                s["size_pt"] = est
                                s["size_source"] = "bbox-estimated"
                    else:
                        s["size_source"] = "docai"
                    # ★ font_match_confidence: font_original がマッチできたかフロントで判別する用
                    s["needs_font_review"] = not bool(s.get("font_original", "").strip())

                # テキスト埋め込みPDFの場合、PyMuPDFのフォント情報で補強
                if has_text:
                    pymupdf_spans = _extract_spans_pymupdf(page)
                    if pymupdf_spans:
                        _merge_font_info(spans, pymupdf_spans, rect.width, rect.height)
                        print(f"Page {i}: Document AI + PyMuPDF font merge → {len(spans)} spans")
                    else:
                        print(f"Page {i}: Document AI OCR → {len(spans)} spans")
                else:
                    print(f"Page {i}: Document AI OCR → {len(spans)} spans")

                # ── DocAI が空/極端に少ない → 手書き日本語用に Vision OCR へ自動フォールバック ──
                # スキャン画像 + Layout Parser だと手書きを拾えないケースが多い
                if not has_text and len(spans) < 3:
                    print(f"Page {i}: DocAI returned only {len(spans)} spans → "
                          f"falling back to Vision DOCUMENT_TEXT_DETECTION")
                    vision_spans = _extract_spans_vision_document(
                        png_bytes, rect.width, rect.height
                    )
                    if vision_spans:
                        spans = vision_spans
                        spans = _merge_context_spans(spans, rect.width, rect.height)
            elif use_vision_ocr and not has_text:
                # ★ Vision OCR 明示選択 (手書き日本語スキャンに最適)
                print(f"Page {i}: Using Vision DOCUMENT_TEXT_DETECTION extraction")
                spans = _extract_spans_vision_document(png_bytes, rect.width, rect.height)
                spans = _merge_context_spans(spans, rect.width, rect.height)
            elif has_text:
                # Document AI 未使用 + テキスト埋め込みPDF → PyMuPDF
                spans = _extract_spans_pymupdf(page)
                if not spans:
                    print(f"Page {i}: PyMuPDF returned 0 spans, falling back to Gemini")
                    spans = _extract_spans_gemini(
                        png_bytes, rect.width, rect.height, api_key=x_gemini_api_key
                    )
                # コンテキストベースのスパン統合
                spans = _merge_context_spans(spans, rect.width, rect.height)
                if spans:
                    print(f"Page {i}: PyMuPDF direct → {len(spans)} spans")
            else:
                # スキャンPDF + Document AI 未使用 → Gemini Vision フォールバック
                print(f"Page {i}: Using Gemini Vision extraction")
                spans = _extract_spans_gemini(
                    png_bytes, rect.width, rect.height, api_key=x_gemini_api_key
                )
                # コンテキストベースのスパン統合（Gemini結果にも適用）
                spans = _merge_context_spans(spans, rect.width, rect.height)

            # ── ★ 全抽出経路共通: HITL メタデータ付与 ──
            # どの経路で抽出されたかに関わらず、size_source と needs_font_review を設定する。
            # DocAI 経路で既にセットされている場合は保持。
            for s in spans:
                if "size_source" not in s:
                    s["size_source"] = (
                        "pymupdf" if (s.get("id") or "").startswith("ctx_")
                        else "gemini" if (s.get("id") or "").startswith("s_")
                        else "docai" if (s.get("id") or "").startswith("dai_")
                        else "vision" if (s.get("id") or "").startswith("viz_")
                        else "unknown"
                    )
                if "needs_font_review" not in s:
                    fo = (s.get("font_original", "") or "").strip()
                    # font_original が空 or 旧ダミー文字列 → 要確認
                    s["needs_font_review"] = (
                        not fo
                        or fo in ("Gemini_Extracted", "YomiToku", "Manual")
                    )
                # font_candidates が欠落している経路(YomiToku等)でも空配列で正規化
                if "font_candidates" not in s:
                    s["font_candidates"] = []

            # ── ★ 4エンジン統合: Gemini AI によるフォント同定を必ず併走 ──
            # プライマリが PyMuPDF / DocAI / YomiToku でも、API キーがあれば
            # AI 候補を追加して font_candidates を充実させる。
            # (プライマリが Gemini の場合は _extract_spans_gemini が既に候補を埋めているのでスキップ)
            primary_was_gemini = bool(spans) and str(spans[0].get("id", "")).startswith("s_")
            if not primary_was_gemini:
                try:
                    _ai_font_candidates_for_spans(png_bytes, spans, api_key=x_gemini_api_key)
                    print(f"Page {i}: AI font candidates merged")
                except Exception as ai_err:
                    print(f"Page {i}: AI font candidates skipped: {ai_err}")

            # ── 画像抽出（PyMuPDF + Document AI + Vision API） ──
            images_data = []

            # ── PyMuPDF: page.get_image_info() の bbox を直接使う（動作確認済パターン） ──
            # ai-cloud-ja-composer/backend/main.py で稼働中の手法。
            # get_images(full=True) + get_image_rects() の組合せは使わない。
            try:
                pt_w = rect.width
                pt_h = rect.height
                infos = page.get_image_info() or []
                print(f"Page {i}: get_image_info → {len(infos)} image instance(s)")

                for inst_idx, info in enumerate(infos):
                    ibbox = info.get("bbox")
                    if not ibbox or len(ibbox) < 4:
                        continue
                    bx0, by0, bx1, by1 = float(ibbox[0]), float(ibbox[1]), float(ibbox[2]), float(ibbox[3])
                    bw, bh = bx1 - bx0, by1 - by0
                    if bw <= 0 or bh <= 0:
                        continue
                    x_pct = bx0 / pt_w * 100
                    y_pct = by0 / pt_h * 100
                    w_pct = bw / pt_w * 100
                    h_pct = bh / pt_h * 100
                    # 極小ノイズ除去
                    if w_pct < 0.5 and h_pct < 0.5:
                        continue

                    # 画像データ: ページの該当領域をクロップして PNG 化（確実）
                    # xref 経由の extract_image は形式依存で失敗することがあるため、
                    # get_pixmap(clip) の方が堅牢。
                    img_b64 = None
                    try:
                        clip = fitz.Rect(bx0, by0, bx1, by1)
                        crop_pix = page.get_pixmap(matrix=fitz.Matrix(3, 3), clip=clip)
                        img_bytes = crop_pix.tobytes("png")
                        img_b64 = base64.b64encode(img_bytes).decode("utf-8")
                    except Exception as crop_err:
                        print(f"  img[{inst_idx}] crop failed: {crop_err}")
                        continue

                    # xref は置換用に保持（取れる場合）
                    xref = 0
                    for img_tuple in page.get_images(full=True):
                        try:
                            rects = page.get_image_rects(img_tuple[0]) or []
                            for r in rects:
                                if abs(r.x0 - bx0) < 2 and abs(r.y0 - by0) < 2:
                                    xref = img_tuple[0]
                                    break
                            if xref:
                                break
                        except Exception:
                            continue

                    images_data.append({
                        "id": f"img_{i}_{inst_idx}",
                        "xref": xref,
                        "data_b64": img_b64,
                        "mime_type": "image/png",
                        "width": int(info.get("width") or bw),
                        "height": int(info.get("height") or bh),
                        "x_pct": x_pct,
                        "y_pct": y_pct,
                        "w_pct": w_pct,
                        "h_pct": h_pct,
                        "bbox": [x_pct, y_pct, w_pct, h_pct],
                    })
                    print(f"  img[{inst_idx}] xref={xref} ({x_pct:.1f},{y_pct:.1f}) {w_pct:.1f}x{h_pct:.1f}%")

                print(f"Page {i}: PyMuPDF extracted {len(images_data)} image(s)")
            except Exception as pymupdf_img_err:
                import traceback
                print(f"PyMuPDF image extraction error: {pymupdf_img_err}")
                traceback.print_exc()

            # ── Document AI layout_blocks からの画像検出 ──
            if docai_layout_blocks and PILImage:
                try:
                    pil_img = PILImage.open(BytesIO(png_bytes))
                    png_w, png_h = pil_img.size
                    docai_img_count = 0
                    for lb_idx, lb in enumerate(docai_layout_blocks):
                        if lb.get("type") != "image":
                            continue
                        # layout_blocks の座標は pct
                        crop_x0 = int(lb["x_pct"] / 100 * png_w)
                        crop_y0 = int(lb["y_pct"] / 100 * png_h)
                        crop_x1 = int((lb["x_pct"] + lb["w_pct"]) / 100 * png_w)
                        crop_y1 = int((lb["y_pct"] + lb["h_pct"]) / 100 * png_h)
                        if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
                            continue
                        cropped = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                        buf = BytesIO()
                        cropped.save(buf, format="PNG")
                        img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                        images_data.append({
                            "id": f"docai_img_{i}_{lb_idx}",
                            "xref": -1,
                            "data_b64": img_b64,
                            "mime_type": "image/png",
                            "width": crop_x1 - crop_x0,
                            "height": crop_y1 - crop_y0,
                            "x_pct": lb["x_pct"],
                            "y_pct": lb["y_pct"],
                            "w_pct": lb["w_pct"],
                            "h_pct": lb["h_pct"],
                            "bbox": [lb["x_pct"], lb["y_pct"], lb["w_pct"], lb["h_pct"]],
                        })
                        docai_img_count += 1
                    if docai_img_count:
                        print(f"Document AI detected {docai_img_count} additional image blocks from layout")
                except Exception as docai_img_err:
                    print(f"DocAI image extraction error: {docai_img_err}")

            # ── Vision API での画像検出（印鑑・ロゴ・スタンプ等 — 常に実行） ──
            if PILImage:
                pre_vis_count = len(images_data)
                try:
                    import os
                    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
                    print(f"Vision API check: GOOGLE_APPLICATION_CREDENTIALS={creds_path}")
                    if not creds_path:
                        print("WARNING: GOOGLE_APPLICATION_CREDENTIALS not set. Vision API logo/photo detection skipped.")
                        print("To enable logo/photo detection, set GOOGLE_APPLICATION_CREDENTIALS environment variable to your service account JSON path.")
                    else:
                        print(f"Vision API: Initializing client with credentials at {creds_path}")
                        client = vision.ImageAnnotatorClient()
                        print("Vision API: Client initialized successfully")
                        vis_image = vision.Image(content=png_bytes)
                        features = [
                            vision.Feature(type_=vision.Feature.Type.OBJECT_LOCALIZATION, max_results=10),
                            vision.Feature(type_=vision.Feature.Type.LOGO_DETECTION, max_results=10),
                            # 名刺のポートレートなど「顔 → ポートレート画像」の自動切り抜き用
                            vision.Feature(type_=vision.Feature.Type.FACE_DETECTION, max_results=5),
                        ]
                        vis_request = vision.AnnotateImageRequest(image=vis_image, features=features)
                        print("Vision API: Calling annotate_image...")
                        vis_response = client.annotate_image(request=vis_request)
                        print(f"Vision API: Got response with {len(vis_response.logo_annotations)} logos, {len(vis_response.localized_object_annotations)} objects, {len(vis_response.face_annotations)} faces")

                        pil_img = PILImage.open(BytesIO(png_bytes))
                        png_w, png_h = pil_img.size
                        vis_img_idx = 0

                        # Object Localization
                        for obj in vis_response.localized_object_annotations:
                            if obj.score < 0.3:
                                continue
                            verts = obj.bounding_poly.normalized_vertices
                            if len(verts) < 4:
                                continue
                            x_min = min(v.x for v in verts)
                            y_min = min(v.y for v in verts)
                            x_max = max(v.x for v in verts)
                            y_max = max(v.y for v in verts)
                            # 既存画像との重複チェック
                            is_dup = False
                            for existing in images_data:
                                if (abs(existing["x_pct"] - x_min * 100) < 5
                                        and abs(existing["y_pct"] - y_min * 100) < 5
                                        and abs(existing["w_pct"] - (x_max - x_min) * 100) < 10):
                                    is_dup = True
                                    break
                            if is_dup:
                                continue
                            crop_x0 = int(x_min * png_w)
                            crop_y0 = int(y_min * png_h)
                            crop_x1 = int(x_max * png_w)
                            crop_y1 = int(y_max * png_h)
                            if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
                                continue
                            cropped = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                            buf = BytesIO()
                            cropped.save(buf, format="PNG")
                            img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                            images_data.append({
                                "id": f"vis_obj_{i}_{vis_img_idx}",
                                "xref": -1,
                                "data_b64": img_b64,
                                "mime_type": "image/png",
                                "width": crop_x1 - crop_x0,
                                "height": crop_y1 - crop_y0,
                                "x_pct": x_min * 100,
                                "y_pct": y_min * 100,
                                "w_pct": (x_max - x_min) * 100,
                                "h_pct": (y_max - y_min) * 100,
                                "bbox": [x_min * 100, y_min * 100, (x_max - x_min) * 100, (y_max - y_min) * 100],
                                "label": f"{obj.name} ({obj.score:.0%})",
                            })
                            vis_img_idx += 1

                        # Logo Detection
                        for logo in vis_response.logo_annotations:
                            if logo.score < 0.3:
                                continue
                            verts = logo.bounding_poly.vertices
                            if len(verts) < 4:
                                continue
                            x_min = min(v.x for v in verts) / png_w
                            y_min = min(v.y for v in verts) / png_h
                            x_max = max(v.x for v in verts) / png_w
                            y_max = max(v.y for v in verts) / png_h
                            crop_x0 = int(x_min * png_w)
                            crop_y0 = int(y_min * png_h)
                            crop_x1 = int(x_max * png_w)
                            crop_y1 = int(y_max * png_h)
                            if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
                                continue
                            # 既存の画像と重複チェック
                            is_dup = False
                            for existing in images_data:
                                if abs(existing["x_pct"] - x_min * 100) < 3 and abs(existing["y_pct"] - y_min * 100) < 3:
                                    is_dup = True
                                    break
                            if is_dup:
                                continue
                            cropped = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                            buf = BytesIO()
                            cropped.save(buf, format="PNG")
                            img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                            images_data.append({
                                "id": f"vis_logo_{i}_{vis_img_idx}",
                                "xref": -1,
                                "data_b64": img_b64,
                                "mime_type": "image/png",
                                "width": crop_x1 - crop_x0,
                                "height": crop_y1 - crop_y0,
                                "x_pct": x_min * 100,
                                "y_pct": y_min * 100,
                                "w_pct": (x_max - x_min) * 100,
                                "h_pct": (y_max - y_min) * 100,
                                "bbox": [x_min * 100, y_min * 100, (x_max - x_min) * 100, (y_max - y_min) * 100],
                                "label": f"Logo: {logo.description} ({logo.score:.0%})",
                            })
                            vis_img_idx += 1

                        # ── Face Detection → ポートレート画像として自動切り抜き ──
                        # 名刺の顔写真など、Object Localization で "Person" が返らないケースでも
                        # Face Detection は確実に顔を捉える。顔 bbox を上下左右にパディングして
                        # 肩・胸までを含んだポートレートを抽出する。
                        for face in vis_response.face_annotations:
                            # detection_confidence: 0.0-1.0 (likelihood enum ではなく float)
                            face_conf = float(getattr(face, "detection_confidence", 0.0) or 0.0)
                            if face_conf < 0.5:
                                continue
                            verts = face.bounding_poly.vertices
                            if len(verts) < 4:
                                continue
                            fx0 = min(v.x for v in verts)
                            fy0 = min(v.y for v in verts)
                            fx1 = max(v.x for v in verts)
                            fy1 = max(v.y for v in verts)
                            fw = fx1 - fx0
                            fh = fy1 - fy0
                            if fw <= 0 or fh <= 0:
                                continue
                            # ポートレート枠: 左右に 0.6*w、上に 0.5*h、下に 1.8*h (胸上まで)
                            px0 = max(0, int(fx0 - fw * 0.6))
                            py0 = max(0, int(fy0 - fh * 0.5))
                            px1 = min(png_w, int(fx1 + fw * 0.6))
                            py1 = min(png_h, int(fy1 + fh * 1.8))
                            if px1 <= px0 or py1 <= py0:
                                continue
                            x_min_n = px0 / png_w
                            y_min_n = py0 / png_h
                            x_max_n = px1 / png_w
                            y_max_n = py1 / png_h
                            # 重複チェック (Object Localization の Person と被る可能性)
                            is_dup = False
                            for existing in images_data:
                                if (abs(existing["x_pct"] - x_min_n * 100) < 5
                                        and abs(existing["y_pct"] - y_min_n * 100) < 5
                                        and abs(existing["w_pct"] - (x_max_n - x_min_n) * 100) < 10):
                                    is_dup = True
                                    break
                            if is_dup:
                                continue
                            cropped = pil_img.crop((px0, py0, px1, py1))
                            buf = BytesIO()
                            cropped.save(buf, format="PNG")
                            img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                            images_data.append({
                                "id": f"vis_face_{i}_{vis_img_idx}",
                                "xref": -1,
                                "data_b64": img_b64,
                                "mime_type": "image/png",
                                "width": px1 - px0,
                                "height": py1 - py0,
                                "x_pct": x_min_n * 100,
                                "y_pct": y_min_n * 100,
                                "w_pct": (x_max_n - x_min_n) * 100,
                                "h_pct": (y_max_n - y_min_n) * 100,
                                "bbox": [x_min_n * 100, y_min_n * 100,
                                         (x_max_n - x_min_n) * 100, (y_max_n - y_min_n) * 100],
                                "label": f"Portrait ({face_conf:.0%})",
                            })
                            vis_img_idx += 1
                            print(f"  Face → portrait crop "
                                  f"({x_min_n*100:.1f},{y_min_n*100:.1f}) "
                                  f"{(x_max_n-x_min_n)*100:.1f}x{(y_max_n-y_min_n)*100:.1f}% "
                                  f"conf={face_conf:.2f}")

                        vis_added = len(images_data) - pre_vis_count
                        if vis_added:
                            print(f"Vision API detected {vis_added} additional images (objects+logos+faces)")
                except Exception as vis_img_err:
                    print(f"Vision API image detection error: {vis_img_err}")

            # ── Gemini Vision による非テキスト画像領域の検出（ロゴ・写真・認証マーク等） ──
            # Vision API の LOGO_DETECTION は著名ブランドしか検出できないため、
            # Gemini に「テキスト以外の視覚要素のバウンディングボックス」を列挙させる。
            if PILImage and GEMINI_API_KEY:
                pre_gem_count = len(images_data)
                try:
                    gemini_regions = _detect_image_regions_gemini(png_bytes)
                    pil_img = PILImage.open(BytesIO(png_bytes))
                    png_w, png_h = pil_img.size
                    gem_img_idx = 0
                    for region in gemini_regions:
                        x_pct = float(region.get("x_pct", 0))
                        y_pct = float(region.get("y_pct", 0))
                        w_pct = float(region.get("w_pct", 0))
                        h_pct = float(region.get("h_pct", 0))
                        label = str(region.get("label", "image"))
                        if w_pct <= 1 or h_pct <= 1:
                            continue
                        # 重複チェック
                        is_dup = False
                        for existing in images_data:
                            if (abs(existing["x_pct"] - x_pct) < 3
                                    and abs(existing["y_pct"] - y_pct) < 3
                                    and abs(existing["w_pct"] - w_pct) < 5):
                                is_dup = True
                                break
                        if is_dup:
                            continue
                        crop_x0 = int((x_pct / 100) * png_w)
                        crop_y0 = int((y_pct / 100) * png_h)
                        crop_x1 = int(((x_pct + w_pct) / 100) * png_w)
                        crop_y1 = int(((y_pct + h_pct) / 100) * png_h)
                        if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
                            continue
                        cropped = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                        buf = BytesIO()
                        cropped.save(buf, format="PNG")
                        img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                        images_data.append({
                            "id": f"gem_img_{i}_{gem_img_idx}",
                            "xref": -1,
                            "data_b64": img_b64,
                            "mime_type": "image/png",
                            "width": crop_x1 - crop_x0,
                            "height": crop_y1 - crop_y0,
                            "x_pct": x_pct,
                            "y_pct": y_pct,
                            "w_pct": w_pct,
                            "h_pct": h_pct,
                            "bbox": [x_pct, y_pct, w_pct, h_pct],
                            "label": label,
                        })
                        gem_img_idx += 1
                    gem_added = len(images_data) - pre_gem_count
                    if gem_added:
                        print(f"Gemini detected {gem_added} additional image regions")
                except Exception as gem_img_err:
                    print(f"Gemini image region detection error: {gem_img_err}")

            if images_data:
                print(f"Page {i}: Total {len(images_data)} images extracted (PyMuPDF+DocAI+Vision+Gemini)")

            # ── 描画要素(罫線・背景色)抽出 ──
            drawings_data = []
            try:
                for d_idx, drawing in enumerate(page.get_drawings()):
                    d_rect = drawing.get("rect", fitz.Rect(0, 0, 0, 0))
                    fill_color = drawing.get("fill")
                    stroke_color = drawing.get("color")
                    # 小さすぎる描画は無視
                    if d_rect.width < 2 and d_rect.height < 2:
                        continue
                    drawings_data.append({
                        "id": f"draw_{i}_{d_idx}",
                        "bbox": [d_rect.x0, d_rect.y0, d_rect.width, d_rect.height],
                        "x_pct": (d_rect.x0 / rect.width) * 100,
                        "y_pct": (d_rect.y0 / rect.height) * 100,
                        "w_pct": (d_rect.width / rect.width) * 100,
                        "h_pct": (d_rect.height / rect.height) * 100,
                        "fill": list(fill_color) if fill_color else None,
                        "color": list(stroke_color) if stroke_color else None,
                    })
            except Exception as draw_err:
                print(f"get_drawings error: {draw_err}")

            # 素材フォルダに抽出画像を保存する
            import uuid
            sozai_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "素材")
            os.makedirs(sozai_dir, exist_ok=True)
            for img in images_data:
                try:
                    b64 = img.get("data_b64")
                    if b64:
                        img_bytes = base64.b64decode(b64)
                        ext = "png"
                        if img.get("mime_type") == "image/jpeg":
                            ext = "jpg"
                        filename = f"extracted_{i}_{uuid.uuid4().hex[:8]}.{ext}"
                        filepath = os.path.join(sozai_dir, filename)
                        with open(filepath, "wb") as f:
                            f.write(img_bytes)
                        img["saved_path"] = filepath
                except Exception as save_err:
                    print(f"Error saving image to 素材: {save_err}")

            pages_data.append({
                "page_index": i,
                "page_pt": [rect.width, rect.height],
                "page_mm": [width_mm, height_mm],
                "spans": spans,
                "raw_id_map": {},
                "images": images_data,
                "drawings": drawings_data,
                "layout_blocks": docai_layout_blocks,
                "barcodes": docai_barcodes,
                "detected_languages": docai_languages,
                "has_text": has_text,
                "has_images": len(images_data) > 0,
                "original_png_b64": original_png_b64,
                "clip_rect": [0, 0, rect.width, rect.height],
            })

        return {
            "pages": pages_data,
            "pdf_b64": base64.b64encode(pdf_bytes).decode("utf-8"),
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"分析失敗: {e}")


# ── /vision-analyze エンドポイント ─────────────────────────────────────────────

class GenerateImageRequest(BaseModel):
    prompt: str
    aspect_ratio: str = "1:1"
    model: str = "imagen-3.0-generate-001"

@app.post("/generate-image")
async def generate_image_api(req: GenerateImageRequest):
    """画像生成AIを利用して、名刺のロゴや写真などの素材を作り直す"""
    if not GEMINI_API_KEY:
        raise HTTPException(500, "Google AI API key is not configured")
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        # Generate image using Imagen
        result = genai.generate_images(
            prompt=req.prompt,
            number_of_images=1,
            model=req.model,
            aspect_ratio=req.aspect_ratio
        )
        
        generated_images = []
        sozai_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "素材")
        os.makedirs(sozai_dir, exist_ok=True)
        import uuid
        
        # Depending on the SDK version, generated_images may differ in structure.
        for g_img in getattr(result, "generated_images", []):
            try:
                img_bytes = g_img.image.image_bytes
            except AttributeError:
                # Some SDKs use different attributes
                continue
                
            filename = f"generated_{uuid.uuid4().hex[:8]}.png"
            filepath = os.path.join(sozai_dir, filename)
            with open(filepath, "wb") as f:
                f.write(img_bytes)
            
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            generated_images.append({
                "data_b64": b64,
                "saved_path": filepath
            })
            
        return {"images": generated_images}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Image generation failed: {e}")

@app.post("/vision-analyze")
async def vision_analyze(req: dict[str, Any]):
    """Cloud Vision API で画像を解析。ラベル/テキスト/ロゴ/物体/Web検出を実行。"""
    image_b64 = req.get("image_b64", "")
    if not image_b64:
        raise HTTPException(400, "image_b64 is required")

    try:
        image_bytes = base64.b64decode(image_b64)
        client = vision.ImageAnnotatorClient()
        image = vision.Image(content=image_bytes)

        # 複数の検出を一括実行
        features = [
            vision.Feature(type_=vision.Feature.Type.LABEL_DETECTION, max_results=10),
            vision.Feature(type_=vision.Feature.Type.TEXT_DETECTION),
            vision.Feature(type_=vision.Feature.Type.LOGO_DETECTION, max_results=5),
            vision.Feature(type_=vision.Feature.Type.OBJECT_LOCALIZATION, max_results=10),
            vision.Feature(type_=vision.Feature.Type.WEB_DETECTION, max_results=5),
            vision.Feature(type_=vision.Feature.Type.SAFE_SEARCH_DETECTION),
            vision.Feature(type_=vision.Feature.Type.IMAGE_PROPERTIES),
        ]

        request = vision.AnnotateImageRequest(image=image, features=features)
        response = client.annotate_image(request=request)

        if response.error.message:
            raise HTTPException(500, f"Vision API Error: {response.error.message}")

        # ── 結果整形 ──
        labels = [
            {"description": l.description, "score": round(l.score, 3)}
            for l in response.label_annotations
        ]

        texts = []
        for t in response.text_annotations:
            verts = t.bounding_poly.vertices
            texts.append({
                "text": t.description,
                "bbox": [
                    {"x": v.x, "y": v.y} for v in verts
                ] if verts else [],
            })

        logos = [
            {"description": l.description, "score": round(l.score, 3)}
            for l in response.logo_annotations
        ]

        objects = []
        for obj in response.localized_object_annotations:
            verts = obj.bounding_poly.normalized_vertices
            objects.append({
                "name": obj.name,
                "score": round(obj.score, 3),
                "bbox": [
                    {"x": round(v.x, 4), "y": round(v.y, 4)} for v in verts
                ] if verts else [],
            })

        # Web検出: 類似画像URL + ベストゲス ラベル
        web = {}
        if response.web_detection:
            wd = response.web_detection
            web = {
                "best_guess_labels": [
                    {"label": g.label, "language": getattr(g, "language_code", "")}
                    for g in getattr(wd, "best_guess_labels", [])
                ],
                "web_entities": [
                    {"description": e.description, "score": round(e.score, 3)}
                    for e in wd.web_entities if e.description
                ][:10],
                "visually_similar_images": [
                    {"url": img.url}
                    for img in getattr(wd, "visually_similar_images", [])
                ][:5],
                "pages_with_matching_images": [
                    {"url": p.url, "title": getattr(p, "page_title", "")}
                    for p in getattr(wd, "pages_with_matching_images", [])
                ][:5],
            }

        # Safe Search
        safe_search = {}
        if response.safe_search_annotation:
            ss = response.safe_search_annotation
            safe_search = {
                "adult": ss.adult.name if ss.adult else "UNKNOWN",
                "violence": ss.violence.name if ss.violence else "UNKNOWN",
                "medical": ss.medical.name if ss.medical else "UNKNOWN",
                "racy": ss.racy.name if ss.racy else "UNKNOWN",
            }

        # 画像プロパティ (主要色)
        dominant_colors = []
        if response.image_properties_annotation:
            colors = response.image_properties_annotation.dominant_colors.colors
            for c in colors[:5]:
                dominant_colors.append({
                    "r": int(c.color.red),
                    "g": int(c.color.green),
                    "b": int(c.color.blue),
                    "score": round(c.score, 3),
                    "pixel_fraction": round(c.pixel_fraction, 3),
                })

        return {
            "labels": labels,
            "texts": texts,
            "logos": logos,
            "objects": objects,
            "web": web,
            "safe_search": safe_search,
            "dominant_colors": dominant_colors,
            "full_text": response.text_annotations[0].description if response.text_annotations else "",
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Vision解析失敗: {e}")


# ── /rebuild ヘルパー ──────────────────────────────────────────────────────────

# ── フォントカタログ + Gemini AI 選定 ──────────────────────────────────────────

_FONT_DIRS = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts"),
    os.path.join(os.path.dirname(__file__), "fonts"),
    "/app/fonts",
    "/usr/share/fonts/google",
]

def _scan_fonts() -> dict[str, str]:
    """fonts/ 内の全 OTF/TTF を {ファイル名: フルパス} で返す"""
    result: dict[str, str] = {}
    for d in _FONT_DIRS:
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if f.lower().endswith((".otf", ".ttf")) and f not in result:
                result[f] = os.path.join(d, f)
    return result

_FONT_FILES = _scan_fonts()
_FONT_CATALOG_STR = "\n".join(sorted(_FONT_FILES.keys()))
print(f"Font catalog: {len(_FONT_FILES)} files")

# Gemini フォント選定キャッシュ {font_original → (filename, size_scale)}
_font_match_cache: dict[str, tuple[str, float]] = {}

_FONT_MATCH_PROMPT = """あなたはDTP・フォントの専門家です。

# タスク
PDFから検出された元フォント名に対して、利用可能なフォントファイルから最も近いフォントを選定してください。
フォントサイズの補正係数も指定してください（元フォントと選定フォントのメトリクス差を考慮）。

# 利用可能なフォントファイル一覧
{catalog}

# 選定ルール
1. ファミリー（ゴシック系→ゴシック系、明朝系→明朝系、欧文→欧文）を合わせる
2. ウェイト（Light, Regular, Medium, Bold, Heavy等）を合わせる
3. Italic/Roman を合わせる
4. 文字セット Pr6 > Pr6N > Pro > Pr5 > Std の優先順
5. サイズ補正: 元フォントと選定フォントの見た目の大きさが近くなるよう係数を指定
   - 同系列なら 1.0
   - NotoSansJP → モリサワゴシック系: 約 0.95
   - 欧文→和文置換: 約 1.0-1.1
   - 不明なら 1.0

# 入力
元フォント名: {font_original}
font_class: {font_class}

# 出力（JSON のみ、他のテキストなし）
{{"filename": "選定したファイル名.otf", "size_scale": 1.0, "reason": "選定理由（10字以内）"}}
"""


def _match_font_gemini(font_original: str, font_class: str) -> tuple[str, float] | None:
    """Gemini AI でフォント選定。成功時 (filename, size_scale) を返す。"""
    api_key = os.environ.get("GOOGLE_AI_KEY", "") or GEMINI_API_KEY
    if not api_key or not _FONT_FILES:
        return None

    prompt = _FONT_MATCH_PROMPT.format(
        catalog=_FONT_CATALOG_STR,
        font_original=font_original,
        font_class=font_class,
    )
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        response = model.generate_content(
            prompt,
            generation_config=genai.GenerationConfig(
                temperature=0.0,
                max_output_tokens=256,
                response_mime_type="application/json",
            ),
        )
        result = json.loads(response.text)
        fname = result.get("filename", "")
        scale = float(result.get("size_scale", 1.0))
        reason = result.get("reason", "")
        if fname in _FONT_FILES:
            print(f"    Gemini font: '{font_original}' → {fname} (scale={scale}, {reason})")
            return fname, scale
        # 大文字小文字の揺れ対応
        for real_name in _FONT_FILES:
            if real_name.lower() == fname.lower():
                print(f"    Gemini font: '{font_original}' → {real_name} (scale={scale}, {reason})")
                return real_name, scale
        print(f"    Gemini returned unknown file: {fname}")
        return None
    except Exception as e:
        print(f"    Gemini font match error: {e}")
        return None


def _match_font(font_original: str, font_class: str, size_pt: float) -> tuple[str | None, float]:
    """font_original → Gemini AI で最適フォントを選定（キャッシュ付き）。
    Returns: (font_file_path, adjusted_size_pt)
    """
    if not _FONT_FILES:
        return None, size_pt

    # キャッシュキー
    cache_key = f"{font_original}|{font_class}"
    if cache_key in _font_match_cache:
        fname, scale = _font_match_cache[cache_key]
        if fname in _FONT_FILES:
            return _FONT_FILES[fname], round(size_pt * scale, 1)
        return None, size_pt

    # Gemini AI で選定
    result = _match_font_gemini(font_original, font_class)
    if result:
        fname, scale = result
        _font_match_cache[cache_key] = (fname, scale)
        return _FONT_FILES[fname], round(size_pt * scale, 1)

    # Gemini 失敗時: font_class ベースの最低限フォールバック
    fallbacks = {
        "gothic":      "A-OTF-GothicBBBPr6-Medium.otf",
        "gothic_bold": "A-OTF-GothicMB101Pr6-Bold.otf",
        "light":       "A-OTF-ShinGoPr6-Light.otf",
        "mincho":      "A-OTF-RyuminPr6-Light.otf",
    }
    fb = fallbacks.get(font_class, fallbacks["gothic"])
    if fb in _FONT_FILES:
        _font_match_cache[cache_key] = (fb, 1.0)
        print(f"    fallback: '{font_original}' → {fb} (Gemini unavailable)")
        return _FONT_FILES[fb], size_pt
    # 最終: Noto
    for noto in ["NotoSansJP.ttf", "NotoSerifJP.ttf"]:
        if noto in _FONT_FILES:
            _font_match_cache[cache_key] = (noto, 1.0)
            return _FONT_FILES[noto], size_pt
    return None, size_pt


# Phase 3: 背景色サンプリング
def _sample_bg_color(page: fitz.Page, rect: fitz.Rect) -> tuple[float, float, float]:
    """rect 四隅のピクセルから背景色を推定"""
    clip = fitz.Rect(rect)
    clip.normalize()
    # rect が空の場合はデフォルト白
    if clip.is_empty or clip.is_infinite:
        return (1.0, 1.0, 1.0)
    try:
        pix = page.get_pixmap(clip=clip, dpi=72)
        if pix.width < 2 or pix.height < 2:
            return (1.0, 1.0, 1.0)
        corners = [
            pix.pixel(0, 0),
            pix.pixel(pix.width - 1, 0),
            pix.pixel(0, pix.height - 1),
            pix.pixel(pix.width - 1, pix.height - 1),
        ]
        r = sum(c[0] for c in corners) / (4 * 255)
        g = sum(c[1] for c in corners) / (4 * 255)
        b = sum(c[2] for c in corners) / (4 * 255)
        return (r, g, b)
    except Exception:
        return (1.0, 1.0, 1.0)


# Phase 4: テキスト色マップ構築
def _build_color_map(page: fitz.Page) -> dict[tuple[int, int], tuple[float, float, float]]:
    """ページ内テキストの (x0,y0) → (r,g,b) マップを構築"""
    color_map: dict[tuple[int, int], tuple[float, float, float]] = {}
    try:
        text_dict = page.get_text("dict")
        for block in text_dict.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    bbox = span.get("bbox", (0, 0, 0, 0))
                    c = span.get("color", 0)
                    rgb = (
                        ((c >> 16) & 0xFF) / 255,
                        ((c >> 8) & 0xFF) / 255,
                        (c & 0xFF) / 255,
                    )
                    color_map[(round(bbox[0]), round(bbox[1]))] = rgb
    except Exception:
        pass
    return color_map


def _lookup_text_color(
    color_map: dict[tuple[int, int], tuple[float, float, float]],
    x0: float, y0: float,
    tolerance: int = 4,
) -> tuple[float, float, float]:
    """近傍マッチで元テキストの色を取得（見つからなければ黒）"""
    rx, ry = round(x0), round(y0)
    for dx in range(-tolerance, tolerance + 1):
        for dy in range(-tolerance, tolerance + 1):
            key = (rx + dx, ry + dy)
            if key in color_map:
                return color_map[key]
    return (0.0, 0.0, 0.0)


# ── /rebuild エンドポイント ────────────────────────────────────────────────────

@app.post("/rebuild")
async def rebuild_pdf(req: dict[str, Any]):
    """PyMuPDF でテキストを置換して修正PDF + プレビュー PNG を返す"""
    pdf_b64 = req.get("pdf_b64", "")
    edits = req.get("edits", {})
    original_texts = req.get("original_texts", {})
    overrides = req.get("overrides", {})
    image_replacements = req.get("image_replacements", {})
    span_bboxes = req.get("span_bboxes", {})  # Phase 2: bbox直接指定
    page_index = req.get("page_index", 0)
    dpi = req.get("dpi", 300)

    if not pdf_b64:
        raise HTTPException(400, "pdf_b64 is required")

    try:
        pdf_bytes = base64.b64decode(pdf_b64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        if page_index < 0 or page_index >= len(doc):
            raise HTTPException(400, f"page_index {page_index} is out of range (total pages: {len(doc)})")
        page = doc.load_page(page_index)

        # ★ pct座標は回転適用後のサイズ基準 → text_dict から実効サイズを取得
        _td = page.get_text("dict")
        _td_w = _td.get("width", 0)
        _td_h = _td.get("height", 0)
        if _td_w > 0 and _td_h > 0:
            eff_rect = fitz.Rect(0, 0, _td_w, _td_h)
        else:
            eff_rect = page.rect

        changes_applied = 0
        skipped_edits = []

        # Phase 4: 色マップを先に構築（redaction 前）
        color_map = _build_color_map(page)

        # ── 全編集の矩形を取得 ──
        edit_plan = []  # [(span_id, new_text, expanded, orig_rect, size_pt, writing_dir, font_class, font_original)]
        for span_id, new_text in edits.items():
            old_text = original_texts.get(span_id, "")
            if not old_text or old_text == new_text:
                continue

            import re
            ov = overrides.get(span_id, {})
            sb = span_bboxes.get(span_id, {})  # Phase 2: bbox直接指定
            x_pct = ov.get("x_pct")
            y_pct = ov.get("y_pct")
            w_pct = ov.get("w_pct")
            h_pct = ov.get("h_pct")
            has_pct = (x_pct is not None and y_pct is not None and w_pct and h_pct)

            rects = []
            use_method = ""

            # ── Step 0 (NEW): span_bboxes から bbox を直接使用 ──
            sb_bbox = sb.get("bbox")
            if sb_bbox and len(sb_bbox) == 4:
                bx, by, bw, bh = sb_bbox
                if bw > 0 and bh > 0:
                    rects = [fitz.Rect(bx, by, bx + bw, by + bh)]
                    use_method = "span-bbox (direct)"

            # Step 1: 完全一致検索（exact match only）
            if not rects:
                exact_rects = page.search_for(old_text)
                if exact_rects:
                    if has_pct:
                        expected_cx = (x_pct / 100) * eff_rect.width + (w_pct / 200) * eff_rect.width
                        expected_cy = (y_pct / 100) * eff_rect.height + (h_pct / 200) * eff_rect.height
                        best_rect = None
                        best_dist = float('inf')
                        for r in exact_rects:
                            cx = (r.x0 + r.x1) / 2
                            cy = (r.y0 + r.y1) / 2
                            dist = ((cx - expected_cx) ** 2 + (cy - expected_cy) ** 2) ** 0.5
                            if dist < best_dist:
                                best_dist = dist
                                best_rect = r
                        diag = (eff_rect.width ** 2 + eff_rect.height ** 2) ** 0.5
                        if best_dist < diag * 0.3:
                            rects = [best_rect]
                            use_method = f"exact-match (dist={best_dist:.0f})"
                        else:
                            print(f"  Exact match found but too far (dist={best_dist:.0f} > {diag*0.3:.0f}): '{old_text[:30]}'")
                    else:
                        rects = exact_rects
                        use_method = "exact-match"

            # Step 2: pct座標フォールバック
            if not rects and has_pct:
                x0 = (x_pct / 100) * eff_rect.width
                y0 = (y_pct / 100) * eff_rect.height
                x1 = x0 + (w_pct / 100) * eff_rect.width
                y1 = y0 + (h_pct / 100) * eff_rect.height
                rects = [fitz.Rect(x0, y0, x1, y1)]
                use_method = "pct-bbox"

            # Step 3: テキスト検索フォールバック
            if not rects and not has_pct:
                no_spaces = re.sub(r'\s+', '', old_text)
                if no_spaces != old_text and len(no_spaces) >= 2:
                    rects = page.search_for(no_spaces)
                    if rects:
                        use_method = "no-spaces"

            if not rects and not has_pct:
                chars = [c for c in old_text if c != ' ']
                if len(chars) >= 3:
                    restored = ''.join(chars)
                    for sep in [':', '：']:
                        if sep in restored:
                            parts = restored.split(sep, 1)
                            restored_with_space = f"{parts[0]}{sep} {parts[1]}"
                            rects = page.search_for(restored_with_space)
                            if rects:
                                use_method = "restored"
                                break
                    if not rects:
                        rects = page.search_for(restored)
                        if rects:
                            use_method = "char-join"

            if not rects and not has_pct:
                no_spaces = re.sub(r'\s+', '', old_text)
                for length in range(min(len(no_spaces), 8), 2, -1):
                    chunk = no_spaces[:length]
                    rects = page.search_for(chunk)
                    if rects:
                        use_method = f"prefix-chunk({chunk})"
                        break

            if not rects and not has_pct:
                for word in old_text.split():
                    if len(word) >= 2:
                        rects = page.search_for(word)
                        if rects:
                            use_method = f"word({word})"
                            break

            # origin フォールバック
            if not rects:
                origin = ov.get("origin") or sb.get("origin")
                if origin and len(origin) >= 2:
                    size_pt_fb = ov.get("size_pt") or sb.get("size_pt") or 9.0
                    wd = ov.get("writing_direction", "horizontal")
                    if wd == "vertical":
                        est_height = len(old_text) * size_pt_fb * 1.5
                        rect_fb = fitz.Rect(
                            origin[0] - size_pt_fb * 0.6, origin[1] - est_height,
                            origin[0] + size_pt_fb * 0.6, origin[1] + 2
                        )
                    else:
                        est_width = len(old_text) * size_pt_fb * 0.7
                        rect_fb = fitz.Rect(
                            origin[0], origin[1] - size_pt_fb * 1.3,
                            origin[0] + est_width, origin[1] + 2
                        )
                    rects = [rect_fb]
                    use_method = f"origin-bbox ({wd})"

            if not rects:
                print(f"Text not found + no position data: '{old_text[:30]}' (span_id={span_id})")
                skipped_edits.append({"span_id": span_id, "text": old_text[:30], "reason": "no_position"})
                continue

            print(f"  [{span_id}] method={use_method}: '{old_text[:25]}' → '{new_text[:25]}'")

            rect = rects[0]
            size_pt = ov.get("size_pt") or sb.get("size_pt") or 0
            if not size_pt:
                size_pt = max(round(rect.height * 0.75, 1), 6.0)
            writing_dir = ov.get("writing_direction", "horizontal")
            font_class = ov.get("font_class") or sb.get("font_class") or "gothic"
            font_original = ov.get("font_original") or sb.get("font_original") or ""

            expanded = fitz.Rect(
                rect.x0 - 1, rect.y0 - 1,
                rect.x1 + 1, rect.y1 + 1
            )
            edit_plan.append((span_id, new_text, expanded, rect, size_pt, writing_dir, font_class, font_original))

        # ── 全 redact annotation を一括追加 → apply ──
        for span_id, new_text, expanded, orig_rect, size_pt, writing_dir, font_class, font_original in edit_plan:
            # Phase 3: 背景色サンプリング
            bg_color = _sample_bg_color(page, expanded)
            page.add_redact_annot(expanded, fill=bg_color)

        if edit_plan:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

        # ── 新テキストを元の位置に挿入 ──
        for span_id, new_text, expanded, orig_rect, size_pt, writing_dir, font_class, font_original in edit_plan:
            try:
                # Phase 1: フォント選定（font_original ベース）
                fontfile, adjusted_size = _match_font(font_original, font_class, size_pt)
                font_kwargs: dict[str, Any] = {}
                if fontfile:
                    font_kwargs["fontfile"] = fontfile
                    size_pt = adjusted_size
                    print(f"  [{span_id}] font: '{font_original}' → {os.path.basename(fontfile)} @ {size_pt}pt")
                else:
                    font_kwargs["fontname"] = "japan"
                    print(f"  [{span_id}] font: '{font_original}' → FALLBACK (japan built-in)")

                # Phase 4: 元テキスト色を取得
                text_color = _lookup_text_color(color_map, orig_rect.x0, orig_rect.y0)

                if writing_dir == "vertical":
                    char_h = size_pt * 1.5
                    x_pos = orig_rect.x0 + (orig_rect.width - size_pt) / 2
                    y_start = orig_rect.y0 + size_pt + 2
                    for ci, ch in enumerate(new_text):
                        page.insert_text(
                            fitz.Point(x_pos, y_start + ci * char_h),
                            ch,
                            fontsize=size_pt,
                            color=text_color,
                            **font_kwargs,
                        )
                    changes_applied += 1
                else:
                    page.insert_text(
                        fitz.Point(orig_rect.x0, orig_rect.y1 - 1),
                        new_text,
                        fontsize=size_pt,
                        color=text_color,
                        **font_kwargs,
                    )
                    changes_applied += 1
            except Exception as e:
                print(f"insert_text error [{span_id}]: {e}")
                skipped_edits.append({"span_id": span_id, "text": new_text[:30], "reason": f"insert_error: {e}"})

        # ── 画像差し替え ──
        images_replaced = 0
        for img_id, new_img_data in image_replacements.items():
            try:
                new_b64 = new_img_data.get("data_b64", "")
                if not new_b64:
                    continue
                new_img_bytes = base64.b64decode(new_b64)
                xref = new_img_data.get("xref")

                # ── 方法1: rect (pt座標) が直接指定されている場合 ──
                img_rect_data = new_img_data.get("rect")
                if img_rect_data and len(img_rect_data) == 4:
                    img_rect = fitz.Rect(img_rect_data)
                    page.insert_image(img_rect, stream=new_img_bytes, overlay=True)
                    images_replaced += 1
                    print(f"  Image {img_id}: replaced via rect {img_rect}")
                    continue

                # ── 方法2: pct座標 → pt座標に変換して上書き ──
                x_pct = new_img_data.get("x_pct")
                y_pct = new_img_data.get("y_pct")
                w_pct = new_img_data.get("w_pct")
                h_pct = new_img_data.get("h_pct")
                if x_pct is not None and y_pct is not None and w_pct and h_pct:
                    x0 = x_pct / 100 * eff_rect.width
                    y0 = y_pct / 100 * eff_rect.height
                    x1 = x0 + w_pct / 100 * eff_rect.width
                    y1 = y0 + h_pct / 100 * eff_rect.height
                    img_rect = fitz.Rect(x0, y0, x1, y1)
                    page.insert_image(img_rect, stream=new_img_bytes, overlay=True)
                    images_replaced += 1
                    print(f"  Image {img_id}: replaced via pct→rect {img_rect}")
                    continue

                # ── 方法3: 有効な xref がある場合 ──
                if xref and xref > 0:
                    try:
                        pix = fitz.Pixmap(new_img_bytes)
                        doc.replace_image(xref, pixmap=pix)
                        images_replaced += 1
                        print(f"  Image {img_id}: replaced via xref={xref}")
                    except Exception:
                        try:
                            img_rects = page.get_image_rects(xref)
                            if img_rects:
                                page.insert_image(img_rects[0], stream=new_img_bytes, overlay=True)
                                images_replaced += 1
                                print(f"  Image {img_id}: replaced via xref→rect fallback")
                        except Exception as xref_err:
                            print(f"  Image {img_id}: xref={xref} fallback failed: {xref_err}")
                else:
                    print(f"  Image {img_id}: skipped — no rect, no pct, no valid xref")
            except Exception as img_err:
                print(f"Image replace error ({img_id}): {img_err}")

        print(f"Rebuild: text={changes_applied}/{len(edits)}, images={images_replaced}/{len(image_replacements)}")

        new_pdf_bytes = doc.write()

        # プレビュー PNG 生成
        page = doc.load_page(page_index)
        scale = dpi / 72
        mat = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=mat)
        png_bytes = pix.tobytes("png")
        # pixmap から実効 pt サイズを逆算（rotation 安全）
        eff_w = pix.width / scale
        eff_h = pix.height / scale
        doc.close()

        return {
            "pdf_b64": base64.b64encode(
                new_pdf_bytes).decode("utf-8"),
            "png_b64": base64.b64encode(
                png_bytes).decode("utf-8"),
            "page_pt": [eff_w, eff_h],
            "page_mm": [eff_w * 0.352778, eff_h * 0.352778],
            "changes_applied": changes_applied,
            "images_replaced": images_replaced,
            "skipped_edits": skipped_edits,
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"再構築失敗: {e}")


# ── /vivliostyle-build エンドポイント ─────────────────────────────────────────

def _generate_html_css(
    spans: list[VivliostyleSpan],
    page_mm: list[float],
    title: str,
    bg_image_b64: Optional[str] = None,
) -> tuple[str, str]:
    """スパンデータからVivliostyle用HTML+CSSを生成
    各スパンの font_original を Gemini AI で最適フォントに変換。
    """
    w_mm, h_mm = page_mm[0], page_mm[1]

    # ── 各スパンごとに Gemini でフォント選定 ──
    font_face_css = ""
    font_face_added: set[str] = set()    # {font_file_path}
    span_font_info: list[tuple[str, float]] = []  # [(css_font_family, adjusted_size)]

    for s in spans:
        fo = s.font_original or ""
        fp, adj_size = _match_font(fo, s.font_class, s.size_pt)
        if fp and fp not in font_face_added:
            fname = os.path.splitext(os.path.basename(fp))[0]
            fmt = "truetype" if fp.lower().endswith(".ttf") else "opentype"
            font_face_css += f"""@font-face {{
  font-family: '{fname}';
  src: url('file://{fp}') format('{fmt}');
}}
"""
            font_face_added.add(fp)

        if fp:
            fname = os.path.splitext(os.path.basename(fp))[0]
            is_serif = s.font_class == "mincho"
            fallback = "'Noto Serif JP', serif" if is_serif else "'Noto Sans JP', sans-serif"
            span_font_info.append((f"'{fname}', {fallback}", adj_size))
        else:
            fallback = "'Noto Serif JP', serif" if s.font_class == "mincho" else "'Noto Sans JP', sans-serif"
            span_font_info.append((fallback, s.size_pt))

    css = f"""@page {{
  size: {w_mm}mm {h_mm}mm;
  margin: 0;
  bleed: 3mm;
  marks: crop cross;
}}

{font_face_css}
@font-face {{
  font-family: 'Noto Sans JP';
  src: local('Noto Sans JP'), local('NotoSansJP');
  font-weight: 100 900;
}}

@font-face {{
  font-family: 'Noto Serif JP';
  src: local('Noto Serif JP'), local('NotoSerifJP');
  font-weight: 100 900;
}}

* {{ margin: 0; padding: 0; box-sizing: border-box; }}

body {{
  width: {w_mm}mm;
  height: {h_mm}mm;
  position: relative;
  overflow: hidden;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}

.card-container {{
  position: relative;
  width: 100%;
  height: 100%;
}}

.span-element {{
  position: absolute;
  white-space: nowrap;
  line-height: 1.4;
}}
"""

    elements_html = ""
    for i, s in enumerate(spans):
        font_family, adj_size = span_font_info[i]
        elements_html += (
            f'    <div class="span-element" style="'
            f"left: {s.x_pct}%; top: {s.y_pct}%; "
            f"font-family: {font_family}; "
            f'font-size: {adj_size}pt;">{s.text}</div>\n'
        )

    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>{title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="card-container" {f'style="background-image: url(data:image/png;base64,{bg_image_b64});"' if bg_image_b64 else ""}>
{elements_html}  </div>
</body>
</html>"""

    return html, css
# ── AI Agent エンドポイント (GCP Gemini活用) ──────────────────────────────

class ExtractInstructionRequest(BaseModel):
    content_text: str
    analyze_data: Optional[Dict[str, Any]] = None

@app.post("/agent/extract-instruction")
async def extract_instruction(req: ExtractInstructionRequest):
    """
    GCP (Gemini) を利用して抽出されたテキストから組版指示書（JSON）を推測・生成する
    """
    api_key = os.environ.get("GOOGLE_AI_KEY", "") or GEMINI_API_KEY
    if not api_key:
        raise HTTPException(500, "Google AI API key is not configured")
    
    try:
        genai.configure(api_key=api_key)
        # より高度な解析（Doc AI/Vision連携）のため pro モデルを使用
        model = genai.GenerativeModel("gemini-2.5-pro") 
        
        prompt = f"""
あなたは印刷・DTP組版の専門家です。
以下の【原稿テキスト】および【Document AI / Vision / 読み分け解析データ】を分析し、
最適な組版仕様を極めて正確に推測して「完璧な組版指示書（JSON）」として出力してください。
名刺、パンフレット、書籍など、テキストの内容とレイアウト構造から媒体を推測し、それに適したルールを構築してください。

【原稿テキスト】
{req.content_text}
"""
        if req.analyze_data:
            import json
            # 解析データが大きすぎる場合を考慮し先頭5000文字に制限
            analyze_str = json.dumps(req.analyze_data, ensure_ascii=False)
            prompt += f"""
【Document AI / Vision / 読み分け解析データ (JSON構造)】
{analyze_str[:8000]}
※上記の座標情報（x_pct, y_pct等）やブロック情報を読み分け（Yomiwake）の構造的意図として捉え、
どの文字が見出しでどれが本文か、またレイアウトの配置意図を完璧に指示書へ反映してください。
"""
        prompt += """
【要件】
1. テキストから品名（名刺、ポスター、書籍など）を推測し、`product_name.value` に設定してください。
2. その媒体にふさわしい文字サイズやフォント構成を `layout_rules` に設定してください。
3. 推測した媒体が「名刺」である場合は、原稿テキストを解析して構造化した名刺コンテンツ（会社名、部署、役職、氏名、住所、電話番号、メールなど）を `content` に出力してください。名刺以外の場合も、適宜要素を抽出して `content` に出力してください。

【出力形式】
以下のJSON構造で返却してください。マークダウンの ```json などは含めないでください。
{{
  "project_metadata": {{
    "system_version": "TypoPro-Web v1.0",
    "status": "In Proofing (初校調整中)"
  }},
  "instruction_manual": {{
    "header": {{
      "product_name": {{ "label_jp": "品名", "value": "推測した品名（例: 名刺、チラシ、小冊子など）" }}
    }},
    "layout_rules": {{
      "grid": "推測した基本グリッドサイズ（例: 8pt, 13Q）",
      "fonts": ["推測した基本フォント指定1", "推測した基本フォント指定2"]
    }}
  }},
  "content": {{
    "company_name": "抽出した会社名",
    "department": "抽出した部署名",
    "title": "抽出した役職",
    "name": "抽出した氏名",
    "address": "抽出した住所",
    "tel": "抽出した電話番号",
    "email": "抽出したメールアドレス",
    "website": "抽出したウェブサイトURL",
    "other": "その他の情報"
  }}
}}
"""
        response = model.generate_content(
            prompt,
            generation_config=genai.GenerationConfig(
                temperature=0.2,
                response_mime_type="application/json"
            )
        )
        return json.loads(response.text)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Extract Instruction Error: {e}")

class DtpAgentRequest(BaseModel):
    instruction_manual: dict[str, Any]
    content_text: str

@app.post("/agent/dtp-layout")
async def dtp_agent(req: DtpAgentRequest):
    """
    GCP (Gemini) を利用したAIエージェント。
    伝統的な組版指示書（JSON）と原稿テキストを読み取り、Vivliostyle用のHTML/CSSを自動生成する。
    """
    api_key = os.environ.get("GOOGLE_AI_KEY", "") or GEMINI_API_KEY
    if not api_key:
        raise HTTPException(500, "Google AI API key is not configured")
    
    try:
        genai.configure(api_key=api_key)
        # 複雑なコーディングと推論が必要なため Pro モデルを使用
        model = genai.GenerativeModel("gemini-2.5-pro") 
        
        prompt = f"""
あなたは印刷・DTP組版の専門家であり、Vivliostyle (CSS Typesetting) のエキスパートエージェントです。
ユーザーから「組版指示書（JSONデータ）」と「原稿テキスト」が渡されます。
この指示書を解釈し、Vivliostyleで印刷可能な高品質の HTML と CSS を生成してください。

【組版指示書】
{json.dumps(req.instruction_manual, ensure_ascii=False, indent=2)}

【原稿テキスト】
{req.content_text}

【要件】
1. 指示書にある「仕上り大きさ」「組方向 (縦: vertical-rl)」「段数」「文字サイズ (1Q = 0.25mm)」「行間・字送り」を計算し、CSSに適用すること。
2. @page ルールを使用し、余白（天・地・ノド・コグチ）を設定すること。
3. ヘッダー（柱）やノンブル（ページ番号）も @page のマージンボックス（@top-right, @bottom-center 等）を用いて配置すること。
4. 原稿テキスト、または組版指示書内の `content` データ（名刺の構造化データなど）を適切にHTMLタグ（h1, h2, p, div など）でマークアップし、デザイン性の高いレイアウトを構築すること。
5. 禁則処理やぶら下げ、和文・欧文間のアキ設定などもCSS（text-autospace, line-break 等）で表現可能な範囲で実装すること。

【出力形式】
以下のキーを持つJSONで返却してください。マークダウンの ```json などは含めないでください。
{{
  "html": "<!DOCTYPE html><html>...",
  "css": "@page {{ ... }} body {{ ... }}"
}}
"""
        response = model.generate_content(
            prompt,
            generation_config=genai.GenerationConfig(
                temperature=0.1,
                response_mime_type="application/json"
            )
        )
        return json.loads(response.text)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"DTP Agent Error: {e}")


@app.post("/vivliostyle-build")
async def vivliostyle_build(req: VivliostyleBuildRequest):
    """Vivliostyle CLI で HTML+CSS → 印刷用PDF生成"""
    vivliostyle_cmd = shutil.which("vivliostyle")
    use_npx = False
    if not vivliostyle_cmd:
        npx_cmd = shutil.which("npx")
        if npx_cmd:
            use_npx = True
            vivliostyle_cmd = npx_cmd
        else:
            raise HTTPException(500, "vivliostyle CLI が見つかりません")

    if req.raw_html and req.raw_css:
        html_content = req.raw_html
        css_content = req.raw_css
    else:
        html_content, css_content = _generate_html_css(
            req.spans, req.page_mm, req.title, req.bg_image_b64
        )
    if req.save_dir_name:
        tmpdir = os.path.join(os.getcwd(), req.save_dir_name)
        os.makedirs(tmpdir, exist_ok=True)
    else:
        tmpdir = tempfile.mkdtemp(prefix="vivliostyle_")

    try:
        html_path = os.path.join(tmpdir, "index.html")
        css_path = os.path.join(tmpdir, "style.css")
        pdf_path = os.path.join(tmpdir, "output.pdf")

        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_content)
        with open(css_path, "w", encoding="utf-8") as f:
            f.write(css_content)

        # 画像の保存
        if req.images:
            for img in req.images:
                img_id = img.get("id")
                img_b64 = img.get("b64")
                if img_id and img_b64:
                    if img_b64.startswith("data:image"):
                        img_b64 = img_b64.split(",")[1]
                    img_path = os.path.join(tmpdir, img_id)
                    with open(img_path, "wb") as f:
                        f.write(base64.b64decode(img_b64))

        if use_npx:
            cmd = [
                vivliostyle_cmd, "-y", "@vivliostyle/cli",
                "build", html_path, "-o", pdf_path
            ]
        else:
            cmd = [
                vivliostyle_cmd, "build", html_path, "-o", pdf_path
            ]

        print(f"Vivliostyle build: {' '.join(cmd)}")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=tmpdir,
        )

        if result.returncode != 0:
            raise HTTPException(
                500, f"Vivliostyle エラー: {result.stderr[:300]}"
            )

        if not os.path.exists(pdf_path):
            raise HTTPException(500, "PDF が生成されませんでした")

        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()

        return {
            "pdf_b64": base64.b64encode(pdf_bytes).decode(),
            "html": html_content,
            "css": css_content,
            "engine": "vivliostyle",
            "version": "cli 10.3.1 / core 2.40.0",
        }

    except subprocess.TimeoutExpired:
        raise HTTPException(500, "Vivliostyle build タイムアウト (120秒)")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Vivliostyle build 失敗: {e}")
    finally:
        if not req.save_dir_name:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ── MarkItDown ベース: PDF → Markdown → 編集 → PDF パイプライン ──────────────

@app.post("/analyze-markdown")
async def analyze_markdown(
    req: dict[str, Any],
    x_gemini_api_key: str = Header(None, alias="X-Gemini-API-Key"),
):
    """PDF → Markdown変換（MarkItDown + Gemini Vision OCR + Document AI トリプル解析）

    1. MarkItDown（テキスト埋め込みPDF向け・高速）
    2. Gemini Vision OCR（pdf-ocr-obsidian方式・画像OCR）
    3. Document AI（Google最高精度OCR・レイアウト解析）
    4. Gemini 精度検証: 3つの結果を比較し、最高精度のMarkdownを選択
    """
    from markitdown import MarkItDown

    pdf_b64 = req.get("pdf_b64", "")
    if not pdf_b64:
        raise HTTPException(400, "pdf_b64 is required")

    api_key = x_gemini_api_key or GEMINI_API_KEY

    try:
        pdf_bytes = base64.b64decode(pdf_b64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        # テキスト埋め込みの有無を判定
        total_text_chars = 0
        for i in range(len(doc)):
            p = doc.load_page(i)
            total_text_chars += len(p.get_text("text").strip())

        has_embedded_text = total_text_chars > 50

        # ── Step 1: MarkItDown でテキスト抽出 ──
        markitdown_md = ""
        try:
            md_converter = MarkItDown()
            result = md_converter.convert_stream(BytesIO(pdf_bytes), file_extension=".pdf")
            markitdown_md = (result.text_content or "").strip()
            print(f"MarkItDown: {len(markitdown_md)} chars")
        except Exception as mit_err:
            print(f"MarkItDown failed: {mit_err}")

        # ── Step 2: Document AI でテキスト抽出 ──
        docai_md = ""
        try:
            prj = os.environ.get("VITE_GOOGLE_PROJECT_ID", "270124753853")
            loc = os.environ.get("VITE_DOCUMENT_AI_LOCATION", "us")
            proc = os.environ.get("VITE_DOCUMENT_AI_PROCESSOR_ID", "57695b373b653f96")
            ver = os.environ.get("VITE_DOCUMENT_AI_VERSION_ID")
            print(f"Document AI OCR: ({prj}, {loc}, {proc})")
            docai_pages = _extract_spans_documentai(pdf_bytes, prj, loc, proc, ver)
            # Document AI結果をMarkdown形式に変換
            docai_page_texts = []
            for page_data in docai_pages:
                spans = page_data.get("spans", [])
                line_texts = [s.get("text", "") for s in spans]
                docai_page_texts.append("\n".join(line_texts))
            docai_md = "\n\n---\n\n".join([t for t in docai_page_texts if t.strip()])
            print(f"Document AI: {len(docai_md)} chars")
        except Exception as docai_err:
            print(f"Document AI failed: {docai_err}")

        # ── Step 3: Gemini Vision OCR（各ページを画像としてOCR → Markdown） ──
        gemini_pages_md = []
        pages = []

        for i in range(len(doc)):
            page = doc.load_page(i)
            rect = page.rect
            width_mm = rect.width * 0.352778
            height_mm = rect.height * 0.352778

            # 高品質ページ画像
            long_side_pt = max(rect.width, rect.height)
            min_target_px = 3000
            scale_factor = max(3, min_target_px / long_side_pt)
            scale_factor = min(scale_factor, 8)
            pix = page.get_pixmap(matrix=fitz.Matrix(scale_factor, scale_factor))
            png_bytes_page = pix.tobytes("png")
            preview_b64 = base64.b64encode(png_bytes_page).decode("utf-8")

            # Gemini Vision OCR
            page_md = ""
            if api_key:
                try:
                    page_md = _ocr_page_to_markdown(png_bytes_page, api_key, i + 1)
                except Exception as ocr_err:
                    print(f"Gemini OCR page {i} failed: {ocr_err}")

            gemini_pages_md.append(page_md)

            pages.append({
                "page_index": i,
                "width_mm": round(width_mm, 2),
                "height_mm": round(height_mm, 2),
                "width_px": pix.width,
                "height_px": pix.height,
                "preview_b64": preview_b64,
            })

        doc.close()

        # Gemini OCRの結果を結合
        gemini_combined = "\n\n---\n\n".join(
            [md for md in gemini_pages_md if md.strip()]
        )

        # ── Step 4: Gemini 精度検証 — 3つのソースから最良を自動選択 ──
        candidates = {}
        if markitdown_md and len(markitdown_md) > 50:
            candidates["markitdown"] = markitdown_md
        if docai_md and len(docai_md) > 50:
            candidates["document_ai"] = docai_md
        if gemini_combined and len(gemini_combined) > 50:
            candidates["gemini_vision_ocr"] = gemini_combined

        final_markdown = ""
        source = "none"
        accuracy_score = 0
        verification_notes = ""

        if api_key and len(candidates) >= 2 and pages:
            # Gemini に3つの結果を比較させて最良選択
            try:
                final_markdown, source, accuracy_score, verification_notes = (
                    _gemini_verify_accuracy(
                        candidates,
                        pages[0]["preview_b64"],
                        api_key,
                    )
                )
            except Exception as verify_err:
                print(f"Gemini verification failed: {verify_err}")

        # フォールバック: 検証が失敗した場合、長さベースで選択
        if not final_markdown:
            lengths = {k: len(v) for k, v in candidates.items()}
            if lengths:
                best_key = max(lengths, key=lengths.get)
                final_markdown = candidates[best_key]
                source = best_key
                accuracy_score = 85  # 検証なし
            else:
                final_markdown = markitdown_md or gemini_combined or docai_md or "(テキストを抽出できません)"
                source = "fallback"
                accuracy_score = 50

        print(f"Final: source={source}, accuracy={accuracy_score}%, "
              f"{len(final_markdown)} chars, {len(pages)} pages")

        return {
            "markdown": final_markdown,
            "pages": pages,
            "total_pages": len(pages),
            "source": source,
            "accuracy_score": accuracy_score,
            "verification_notes": verification_notes,
            "markitdown_md": markitdown_md,
            "gemini_md": gemini_combined,
            "docai_md": docai_md,
            "sources_available": list(candidates.keys()),
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Markdown変換失敗: {e}")


def _ocr_page_to_markdown(png_bytes: bytes, api_key: str, page_num: int) -> str:
    """Gemini Vision で1ページ画像をOCRし、構造化Markdownを返す（pdf-ocr-obsidian方式）"""
    import google.generativeai as genai_local
    genai_local.configure(api_key=api_key)

    model = genai_local.GenerativeModel("gemini-2.0-flash")

    prompt = f"""あなたはOCR専門のAIです。この画像はPDFのページ {page_num} です。

画像内の全テキストを **正確に** Markdown形式で抽出してください。

ルール:
1. テキストは100%正確に抽出すること（1文字も漏らさない）
2. 見出しは # ## ### で表現
3. 箇条書きは - で表現
4. 表はMarkdownテーブル形式で表現  
5. テキストの順序は元の文書のレイアウトに従う（上から下、左から右）
6. 装飾テキスト（太字、下線等）はMarkdownの ** で表現
7. 空行やセクションの区切りも再現する  
8. 画像や図表は [画像: 説明] で示す
9. 改行位置も原稿を正確に再現する
10. Markdownのコードブロックで囲まないこと（純粋なMarkdownテキストのみ出力）

テキストのみを出力してください。説明や注釈は不要です。"""

    img_part = {
        "mime_type": "image/png",
        "data": png_bytes,
    }

    response = model.generate_content(
        [prompt, img_part],
        generation_config={"temperature": 0.1, "max_output_tokens": 8192},
    )

    text = response.text.strip()
    # コードブロック内にMarkdownが返された場合、外す
    if text.startswith("```markdown"):
        text = text[len("```markdown"):].strip()
    if text.startswith("```"):
        text = text[3:].strip()
    if text.endswith("```"):
        text = text[:-3].strip()

    print(f"  OCR page {page_num}: {len(text)} chars")
    return text


def _gemini_verify_accuracy(
    candidates: dict[str, str],
    page_preview_b64: str,
    api_key: str,
) -> tuple[str, str, int, str]:
    """Gemini でOCR結果を元PDF画像と比較し、精度スコアと最良結果を返す

    Returns: (best_markdown, source_name, accuracy_score, notes)
    """
    import google.generativeai as genai_local
    genai_local.configure(api_key=api_key)

    model = genai_local.GenerativeModel("gemini-2.0-flash")

    # 候補のサマリーを構築
    candidates_text = ""
    for name, md in candidates.items():
        # 各候補の最初の500文字だけ送信（トークン節約）
        truncated = md[:800] if len(md) > 800 else md
        candidates_text += f"\n\n=== [{name}] ===\n{truncated}\n"

    prompt = f"""あなたはPDF→Markdown変換の精度検証AIです。

元PDFページの画像と、複数のOCRエンジンから抽出されたMarkdownテキストを比較してください。

以下の候補があります:
{candidates_text}

評価基準:
1. テキストの正確性（文字の一致率）
2. レイアウトの再現性（表、見出し、段落の構造）
3. 数値・固有名詞の正確性（金額、日付、人名、社名）
4. 改行位置やインデントの適切さ

回答形式（厳密にこの形式で回答してください）:
BEST: [候補名]
SCORE: [0-100の精度スコア]
NOTES: [簡潔な検証コメント（日本語）]"""

    img_part = {
        "mime_type": "image/png",
        "data": base64.b64decode(page_preview_b64),
    }

    try:
        response = model.generate_content(
            [prompt, img_part],
            generation_config={"temperature": 0.1, "max_output_tokens": 500},
        )
        result_text = response.text.strip()
        print(f"Gemini verification: {result_text[:200]}")

        # パース
        best_name = ""
        score = 85
        notes = ""

        for line in result_text.split("\n"):
            line = line.strip()
            if line.startswith("BEST:"):
                best_name = line.split(":", 1)[1].strip().strip("[]")
            elif line.startswith("SCORE:"):
                try:
                    score = int(line.split(":", 1)[1].strip())
                except ValueError:
                    score = 85
            elif line.startswith("NOTES:"):
                notes = line.split(":", 1)[1].strip()

        # 候補名のマッチング
        matched_key = None
        for key in candidates:
            if key.lower() in best_name.lower() or best_name.lower() in key.lower():
                matched_key = key
                break

        if not matched_key:
            # 一番長い候補をフォールバック
            matched_key = max(candidates, key=lambda k: len(candidates[k]))

        return candidates[matched_key], matched_key, score, notes

    except Exception as e:
        print(f"Gemini verify error: {e}")
        # フォールバック
        best_key = max(candidates, key=lambda k: len(candidates[k]))
        return candidates[best_key], best_key, 80, f"検証失敗: {e}"

@app.post("/markdown-to-pdf")
async def markdown_to_pdf(req: dict[str, Any]):
    """編集済み Markdown → PDF（md2pdf-ja + Vivliostyle フォールバック）

    md2pdf-ja: Puppeteer + marked ベース。日本語（Noto Sans/Serif JP）に最適化。
    GFM / KaTeX / GitHub Alerts / 脚注 / シンタックスハイライト対応。
    縦書き（writing-mode: vertical-rl）オプション対応。
    """
    markdown_text = req.get("markdown", "")
    page_mm = req.get("page_mm", [210, 297])  # デフォルト A4
    theme = req.get("theme", "default")  # default / academic / business
    paper_format = req.get("format", "A4")  # A4 / A5 / B5 / Letter
    vertical = req.get("vertical", False)  # 縦書きモード
    custom_css = req.get("custom_css", "")  # 追加CSS
    title = req.get("title", "")
    author = req.get("author", "")
    page_numbers = req.get("page_numbers", False)
    toc = req.get("toc", False)
    bg_image_b64 = req.get("bg_image_b64")
    original_pdf_b64 = req.get("original_pdf_b64")  # 元PDF（背景用）

    if not markdown_text:
        raise HTTPException(400, "markdown is required")

    try:
        # ── 背景画像CSS生成 ──
        bg_extra_css = ""
        if bg_image_b64:
            bg_extra_css = f"""
body::before {{
  content: "";
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  background-image: url(data:image/png;base64,{bg_image_b64});
  background-size: cover;
  z-index: -1;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}"""
        elif original_pdf_b64:
            try:
                orig_bytes = base64.b64decode(original_pdf_b64)
                orig_doc = fitz.open(stream=orig_bytes, filetype="pdf")
                if len(orig_doc) > 0:
                    orig_page = orig_doc.load_page(0)
                    orig_rect = orig_page.rect
                    scale = max(3, 2000 / max(orig_rect.width, orig_rect.height))
                    scale = min(scale, 6)
                    orig_pix = orig_page.get_pixmap(matrix=fitz.Matrix(scale, scale))
                    orig_png = orig_pix.tobytes("png")
                    orig_b64 = base64.b64encode(orig_png).decode("utf-8")
                    bg_extra_css = f"""
body::before {{
  content: "";
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  background-image: url(data:image/png;base64,{orig_b64});
  background-size: cover;
  z-index: -1;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}"""
                orig_doc.close()
            except Exception as bg_err:
                print(f"Background generation error: {bg_err}")

        # ── 縦書きCSS ──
        vertical_css = ""
        if vertical:
            vertical_css = """
/* 縦書きモード (writing-mode) */
html {
  writing-mode: vertical-rl;
  -webkit-writing-mode: vertical-rl;
  text-orientation: mixed;
}
body {
  writing-mode: vertical-rl;
  -webkit-writing-mode: vertical-rl;
  text-orientation: mixed;
}
h1, h2, h3, h4, h5, h6 {
  text-combine-upright: none;
}
/* 半角英数字の縦中横 */
.tcy {
  text-combine-upright: all;
  -webkit-text-combine: horizontal;
}
"""

        # カスタムCSS 統合
        all_custom_css = "\n".join([bg_extra_css, vertical_css, custom_css]).strip()

        tmpdir = tempfile.mkdtemp(prefix="md2pdfja_")
        try:
            md_path = os.path.join(tmpdir, "input.md")
            pdf_path = os.path.join(tmpdir, "output.pdf")

            with open(md_path, "w", encoding="utf-8") as f:
                f.write(markdown_text)

            # カスタムCSS を一時ファイルに書き出し
            css_path = None
            if all_custom_css:
                css_path = os.path.join(tmpdir, "custom.css")
                with open(css_path, "w", encoding="utf-8") as f:
                    f.write(all_custom_css)

            # md2pdf-ja CLI を実行
            md2pdf_cmd = shutil.which("md2pdf-ja")
            if not md2pdf_cmd:
                # npx フォールバック
                npx = shutil.which("npx")
                if npx:
                    md2pdf_cmd = npx
                    cmd = [md2pdf_cmd, "-y", "@j2masamitu/md2pdf-ja"]
                else:
                    raise HTTPException(500, "md2pdf-ja CLI が見つかりません")
            else:
                cmd = [md2pdf_cmd]

            cmd += [md_path, "-o", pdf_path]

            # テーマ
            if theme in ("academic", "business", "default"):
                cmd += ["--theme", theme]

            # 用紙サイズ
            if paper_format in ("A4", "A5", "B5", "Letter"):
                cmd += ["--format", paper_format]

            # タイトル・著者
            if title:
                cmd += ["-t", title]
            if author:
                cmd += ["-a", author]

            # ページ番号
            if page_numbers:
                cmd += ["--page-numbers"]

            # 目次
            if toc:
                cmd += ["--toc"]

            # カスタムCSS
            if css_path:
                cmd += ["--css", css_path]

            print(f"md2pdf-ja: {' '.join(cmd)}")
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=tmpdir,
                env={**os.environ, "PUPPETEER_CHROMIUM_REVISION": "latest"},
            )

            if proc.returncode != 0:
                stderr_msg = proc.stderr[:500] if proc.stderr else "unknown error"
                print(f"md2pdf-ja stderr: {proc.stderr}")
                print(f"md2pdf-ja stdout: {proc.stdout}")
                # Vivliostyle フォールバック
                print("md2pdf-ja 失敗 → Vivliostyle フォールバック")
                return await _vivliostyle_fallback(
                    markdown_text, page_mm, bg_extra_css, vertical_css, custom_css
                )

            if not os.path.exists(pdf_path):
                print("md2pdf-ja: PDF 未生成 → Vivliostyle フォールバック")
                return await _vivliostyle_fallback(
                    markdown_text, page_mm, bg_extra_css, vertical_css, custom_css
                )

            with open(pdf_path, "rb") as f:
                out_pdf_bytes = f.read()

            # プレビュー PNG 生成
            out_doc = fitz.open(stream=out_pdf_bytes, filetype="pdf")
            previews = []
            for pi in range(len(out_doc)):
                p = out_doc.load_page(pi)
                pr = p.rect
                s = max(2, 2000 / max(pr.width, pr.height))
                s = min(s, 6)
                ppix = p.get_pixmap(matrix=fitz.Matrix(s, s))
                ppng = ppix.tobytes("png")
                previews.append(base64.b64encode(ppng).decode("utf-8"))
            out_doc.close()

            return {
                "pdf_b64": base64.b64encode(out_pdf_bytes).decode("utf-8"),
                "preview_pngs": previews,
                "engine": "md2pdf-ja",
            }

        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Markdown→PDF 変換失敗: {e}")


async def _vivliostyle_fallback(
    markdown_text: str,
    page_mm: list,
    bg_css: str,
    vertical_css: str,
    custom_css: str,
):
    """md2pdf-ja 失敗時の Vivliostyle フォールバック（Gemini AI フォント選定）"""
    import markdown as md_lib

    w_mm = page_mm[0] if len(page_mm) > 0 else 210
    h_mm = page_mm[1] if len(page_mm) > 1 else 297

    html_body = md_lib.markdown(
        markdown_text,
        extensions=["tables", "fenced_code", "nl2br"],
    )

    v_css = ""
    if vertical_css:
        v_css = vertical_css

    # Gemini AI でドキュメントフォント選定
    body_fp, _ = _match_font("GothicBBB-Medium", "gothic", 10)
    heading_fp, _ = _match_font("GothicMB101-Bold", "gothic_bold", 10)
    body_serif_fp, _ = _match_font("Ryumin-Light", "mincho", 10)

    font_face_css = ""
    body_font_family = "'Noto Sans JP', sans-serif"
    heading_font_family = "'Noto Sans JP', sans-serif"

    for fp, role in [(body_fp, "body"), (heading_fp, "heading"), (body_serif_fp, "serif")]:
        if fp:
            fname = os.path.splitext(os.path.basename(fp))[0]
            fmt = "truetype" if fp.lower().endswith(".ttf") else "opentype"
            font_face_css += f"""@font-face {{
  font-family: '{fname}';
  src: url('file://{fp}') format('{fmt}');
}}
"""
            if role == "body":
                body_font_family = f"'{fname}', 'Noto Sans JP', sans-serif"
            elif role == "heading":
                heading_font_family = f"'{fname}', 'Noto Sans JP', sans-serif"

    css_content = f"""@page {{
  size: {w_mm}mm {h_mm}mm;
  margin: 10mm 12mm;
}}

{font_face_css}
@font-face {{
  font-family: 'Noto Sans JP';
  src: local('Noto Sans JP'), local('NotoSansJP');
  font-weight: 100 900;
}}

@font-face {{
  font-family: 'Noto Serif JP';
  src: local('Noto Serif JP'), local('NotoSerifJP');
  font-weight: 100 900;
}}

* {{ margin: 0; padding: 0; box-sizing: border-box; }}

body {{
  font-family: {body_font_family};
  font-size: 10pt;
  line-height: 1.8;
  color: #222;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}

h1 {{ font-family: {heading_font_family}; font-size: 20pt; margin: 0.5em 0 0.3em; font-weight: 700; }}
h2 {{ font-family: {heading_font_family}; font-size: 16pt; margin: 0.4em 0 0.2em; font-weight: 700; }}
h3 {{ font-family: {heading_font_family}; font-size: 13pt; margin: 0.3em 0 0.2em; font-weight: 600; }}

p {{ margin: 0.4em 0; }}
table {{ border-collapse: collapse; margin: 0.5em 0; width: 100%; }}
th, td {{ border: 1px solid #999; padding: 4pt 6pt; text-align: left; font-size: 9pt; }}
th {{ background: #f0f0f0; font-weight: 600; }}
blockquote {{ border-left: 3pt solid #ccc; padding-left: 8pt; margin: 0.3em 0; color: #555; }}
{bg_css}
{v_css}
{custom_css}
"""

    html_content = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Document</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
{html_body}
</body>
</html>"""

    vivliostyle_cmd = shutil.which("vivliostyle")
    use_npx = False
    if not vivliostyle_cmd:
        npx_cmd = shutil.which("npx")
        if npx_cmd:
            use_npx = True
            vivliostyle_cmd = npx_cmd
        else:
            raise HTTPException(500, "vivliostyle CLI が見つかりません")

    tmpdir = tempfile.mkdtemp(prefix="vivlio_fb_")
    try:
        html_path = os.path.join(tmpdir, "index.html")
        css_path = os.path.join(tmpdir, "style.css")
        pdf_path = os.path.join(tmpdir, "output.pdf")

        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_content)
        with open(css_path, "w", encoding="utf-8") as f:
            f.write(css_content)

        if use_npx:
            cmd = [vivliostyle_cmd, "-y", "@vivliostyle/cli", "build", html_path, "-o", pdf_path]
        else:
            cmd = [vivliostyle_cmd, "build", html_path, "-o", pdf_path]

        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=tmpdir)

        if proc.returncode != 0 or not os.path.exists(pdf_path):
            raise HTTPException(500, f"PDF生成失敗（Vivliostyle）: {proc.stderr[:300]}")

        with open(pdf_path, "rb") as f:
            out_pdf_bytes = f.read()

        out_doc = fitz.open(stream=out_pdf_bytes, filetype="pdf")
        previews = []
        for pi in range(len(out_doc)):
            p = out_doc.load_page(pi)
            pr = p.rect
            s = max(2, 2000 / max(pr.width, pr.height))
            s = min(s, 6)
            ppix = p.get_pixmap(matrix=fitz.Matrix(s, s))
            ppng = ppix.tobytes("png")
            previews.append(base64.b64encode(ppng).decode("utf-8"))
        out_doc.close()

        return {
            "pdf_b64": base64.b64encode(out_pdf_bytes).decode("utf-8"),
            "preview_pngs": previews,
            "engine": "vivliostyle_fallback",
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8080)),
    )
