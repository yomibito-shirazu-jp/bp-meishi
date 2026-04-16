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
import subprocess
import tempfile
import shutil
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
from fastapi import FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google.cloud import documentai
from google.cloud import vision
from google.api_core.client_options import ClientOptions

# ── Gemini 設定 ──────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GOOGLE_AI_KEY", "")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

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
    size_pt: float = 10.0
    x_pct: float = 0.0
    y_pct: float = 0.0
    w_pct: float = 50.0
    h_pct: float = 5.0


class VivliostyleBuildRequest(BaseModel):
    spans: list[VivliostyleSpan]
    page_mm: list[float] = [91, 55]
    title: str = "Preview"
    bg_image_b64: Optional[str] = None


# ── ヘルスチェック ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


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

【フォント分類】
- gothic: ゴシック体、サンセリフ体、角ゴシック
- mincho: 明朝体、セリフ体
- gothic_bold: 太ゴシック、ボールド体（見出し等の太字）
- light: 細字、ライト体

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
GEMINI_SPAN_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "text": {"type": "STRING", "description": "テキスト内容"},
            "font_class": {"type": "STRING", "description": "フォント分類: gothic, mincho, gothic_bold, light"},
            "size_pt": {"type": "NUMBER", "description": "推定フォントサイズ(pt)"},
            "x_pct": {"type": "NUMBER", "description": "左端X座標(0-100%)"},
            "y_pct": {"type": "NUMBER", "description": "上端Y座標(0-100%)"},
            "w_pct": {"type": "NUMBER", "description": "幅(0-100%)"},
            "h_pct": {"type": "NUMBER", "description": "高さ(0-100%)"},
            "writing_direction": {"type": "STRING", "description": "組方向: horizontal または vertical"},
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

        spans.append({
            "id": f"s_{int(time.time() * 1000)}_{i}",
            "text": item["text"].strip(),
            "font_original": "Gemini_Extracted",
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


# ── PyMuPDF 直接テキスト抽出（テキスト埋め込みPDF用・最高精度） ──────────────

def _extract_spans_pymupdf(page: Any) -> list[dict[str, Any]]:
    """PyMuPDF でテキスト埋め込みPDFから直接 Span 抽出（行単位）

    テキストが埋め込まれたPDFの場合、Gemini Vision や Document AI OCR よりも
    正確な位置・フォント・サイズ情報を得られる。
    """
    rect = page.rect
    if rect.width <= 0 or rect.height <= 0:
        return []

    result_spans = []

    try:
        text_dict = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_PRESERVE_LIGATURES)
    except Exception as e:
        print(f"PyMuPDF get_text error: {e}")
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
                key = (s.get("font", ""), s.get("size", 9.0))
                font_counts[key] = font_counts.get(key, 0) + len(s.get("text", ""))
            dominant_font, dominant_size = max(font_counts, key=lambda k: font_counts[k])

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

            # 縦書き検出: bbox が縦長 + 複数文字
            bb_w = x1 - x0
            bb_h = y1 - y0
            text_stripped = full_text.strip()
            writing_dir = "vertical" if (bb_h > bb_w * 2.0 and len(text_stripped) > 1) else "horizontal"

            # 縦書きフォント名の検出（日本語フォントの "V" 接尾辞）
            if any(k in font_lower for k in ["-v", "vert", "tate", "縦"]):
                writing_dir = "vertical"

            result_spans.append({
                "id": f"pdf_{block_idx}_{line_idx}_{span_counter}",
                "text": text_stripped,
                "font_original": dominant_font,
                "font_class": font_class,
                "size_pt": round(dominant_size, 1),
                "origin": [round(x0, 2), round(y1, 2)],
                "bbox": [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)],
                "x_pct": round(x_pct, 2),
                "y_pct": round(y_pct, 2),
                "w_pct": round(w_pct, 2),
                "h_pct": round(h_pct, 2),
                "writing_direction": writing_dir,
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

        # ── token → フォントサイズマップ構築 ──
        # Document AI の style 情報からフォントサイズを取得
        font_size_map: dict[str, float] = {}
        try:
            for style in getattr(document, "text_styles", []):
                fs = getattr(style, "font_size", None)
                if fs:
                    size_pt = getattr(fs, "size", 0)
                    unit = getattr(fs, "unit", "")
                    if unit == "PT" or not unit:
                        for seg in style.text_anchor.text_segments:
                            start = int(seg.start_index) if seg.start_index else 0
                            end = int(seg.end_index) if seg.end_index else 0
                            for idx in range(start, end):
                                font_size_map[str(idx)] = size_pt
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

                # フォントクラス推定
                font_class = "gothic"
                if hasattr(line, "style_info") and line.style_info:
                    family = getattr(line.style_info, "font_family", "").lower()
                    if "mincho" in family or "serif" in family:
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

                # 縦書き検出: bounding boxが縦長なら vertical
                bb_w = x_max - x_min
                bb_h = y_max - y_min
                writing_dir = "vertical" if (bb_h > bb_w * 2.0 and len(text.strip()) > 1) else "horizontal"

                page_spans.append({
                    "id": f"dai_{int(time.time() * 1000)}_{i}",
                    "text": text.strip(),
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
):
    """PDF → Gemini または Document AI でSpan抽出"""
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

        # モード選択: Document AI  "false"→無効  それ以外→常に使用（テキスト有無問わず）
        use_docai_mode = (x_use_documentai or "").lower()
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
            rect = page.rect
            width_mm = rect.width * 0.352778
            height_mm = rect.height * 0.352778

            # 適応的スケーリング: 高品質プレビュー用
            long_side_pt = max(rect.width, rect.height)
            min_target_px = 3000
            scale_factor = max(3, min_target_px / long_side_pt)
            scale_factor = min(scale_factor, 8)  # 上限8倍
            pix = page.get_pixmap(matrix=fitz.Matrix(scale_factor, scale_factor))
            png_bytes = pix.tobytes("png")
            original_png_b64 = base64.b64encode(png_bytes).decode("utf-8")
            print(f"Page {i}: {rect.width:.0f}x{rect.height:.0f}pt → "
                  f"{pix.width}x{pix.height}px (scale={scale_factor:.1f}x)")

            # Document AI レイアウト情報
            docai_layout_blocks = []
            docai_barcodes = []
            docai_languages = []

            if use_docai and i < len(docai_results):
                # Document AI 結果を主軸に使用
                docai_page = docai_results[i]
                spans = docai_page["spans"]
                docai_layout_blocks = docai_page.get("layout_blocks", [])
                docai_barcodes = docai_page.get("barcodes", [])
                docai_languages = docai_page.get("detected_languages", [])
                # 座標を pt に変換して追加属性付与
                for s in spans:
                    bx = (s["x_pct"] / 100) * rect.width
                    by = (s["y_pct"] / 100) * rect.height
                    bw = (s["w_pct"] / 100) * rect.width
                    bh = (s["h_pct"] / 100) * rect.height
                    s.update({
                        "origin": [bx, by + bh],
                        "bbox": [bx, by, bw, bh],
                    })

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

            # ── 画像抽出 ──
            images_data = []
            try:
                for img_idx, img_info in enumerate(page.get_images(full=True)):
                    xref = img_info[0]
                    try:
                        base_image = pdf_doc.extract_image(xref)
                        if not base_image or not base_image.get("image"):
                            continue
                        img_bytes = base_image["image"]
                        img_ext = base_image.get("ext", "png")
                        img_w = base_image.get("width", 0)
                        img_h = base_image.get("height", 0)

                        # 画像のページ内位置を探す
                        img_rects = page.get_image_rects(xref)
                        if img_rects:
                            ir = img_rects[0]
                            x_pct = (ir.x0 / rect.width) * 100
                            y_pct = (ir.y0 / rect.height) * 100
                            w_pct = ((ir.x1 - ir.x0) / rect.width) * 100
                            h_pct = ((ir.y1 - ir.y0) / rect.height) * 100
                        else:
                            x_pct, y_pct, w_pct, h_pct = 0, 0, 50, 50

                        img_b64 = base64.b64encode(img_bytes).decode("utf-8")
                        mime = f"image/{img_ext}" if img_ext != "jpg" else "image/jpeg"

                        images_data.append({
                            "id": f"img_{i}_{img_idx}",
                            "xref": xref,
                            "data_b64": img_b64,
                            "mime_type": mime,
                            "width": img_w,
                            "height": img_h,
                            "x_pct": x_pct,
                            "y_pct": y_pct,
                            "w_pct": w_pct,
                            "h_pct": h_pct,
                            "bbox": [x_pct, y_pct, w_pct, h_pct],
                        })
                    except Exception as img_err:
                        print(f"Image extraction error (xref={xref}): {img_err}")
            except Exception as imgs_err:
                print(f"get_images error: {imgs_err}")

            # ── Document AI layout_blocks からの画像検出補強 ──
            if not images_data and docai_layout_blocks and PILImage:
                try:
                    pil_img = PILImage.open(BytesIO(png_bytes))
                    png_w, png_h = pil_img.size
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
                    if images_data:
                        print(f"Document AI detected {len(images_data)} image blocks from layout")
                except Exception as docai_img_err:
                    print(f"DocAI image extraction fallback error: {docai_img_err}")

            # ── Vision API での画像検出（印鑑・ロゴ・スタンプ等） ──
            if not images_data and PILImage:
                try:
                    client = vision.ImageAnnotatorClient()
                    vis_image = vision.Image(content=png_bytes)
                    features = [
                        vision.Feature(type_=vision.Feature.Type.OBJECT_LOCALIZATION, max_results=10),
                        vision.Feature(type_=vision.Feature.Type.LOGO_DETECTION, max_results=10),
                    ]
                    vis_request = vision.AnnotateImageRequest(image=vis_image, features=features)
                    vis_response = client.annotate_image(request=vis_request)

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

                    if images_data:
                        print(f"Vision API detected {len(images_data)} images (objects+logos)")
                except Exception as vis_img_err:
                    print(f"Vision API image detection error: {vis_img_err}")

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

# Phase 1: フォントマッピング
FONT_PATHS = [
    "/usr/share/fonts/google",   # Docker
    "/app/fonts",                # Docker fallback
]

FONT_MAP = {
    "gothic":      "NotoSansJP.ttf",
    "light":       "NotoSansJP.ttf",
    "gothic_bold": "NotoSansJP.ttf",
    "mincho":      "NotoSerifJP.ttf",
}


def _resolve_font(font_class: str) -> str | None:
    """font_class から実フォントファイルパスを解決（なければ None）"""
    fname = FONT_MAP.get(font_class, FONT_MAP["gothic"])
    for d in FONT_PATHS:
        p = os.path.join(d, fname)
        if os.path.exists(p):
            return p
    return None


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

        changes_applied = 0
        skipped_edits = []

        # Phase 4: 色マップを先に構築（redaction 前）
        color_map = _build_color_map(page)

        # ── 全編集の矩形を取得 ──
        edit_plan = []  # [(span_id, new_text, expanded, orig_rect, size_pt, writing_dir, font_class)]
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
                        page_rect = page.rect
                        expected_cx = (x_pct / 100) * page_rect.width + (w_pct / 200) * page_rect.width
                        expected_cy = (y_pct / 100) * page_rect.height + (h_pct / 200) * page_rect.height
                        best_rect = None
                        best_dist = float('inf')
                        for r in exact_rects:
                            cx = (r.x0 + r.x1) / 2
                            cy = (r.y0 + r.y1) / 2
                            dist = ((cx - expected_cx) ** 2 + (cy - expected_cy) ** 2) ** 0.5
                            if dist < best_dist:
                                best_dist = dist
                                best_rect = r
                        diag = (page_rect.width ** 2 + page_rect.height ** 2) ** 0.5
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
                page_rect = page.rect
                x0 = (x_pct / 100) * page_rect.width
                y0 = (y_pct / 100) * page_rect.height
                x1 = x0 + (w_pct / 100) * page_rect.width
                y1 = y0 + (h_pct / 100) * page_rect.height
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

            expanded = fitz.Rect(
                rect.x0 - 1, rect.y0 - 1,
                rect.x1 + 1, rect.y1 + 1
            )
            edit_plan.append((span_id, new_text, expanded, rect, size_pt, writing_dir, font_class))

        # ── 全 redact annotation を一括追加 → apply ──
        for span_id, new_text, expanded, orig_rect, size_pt, writing_dir, font_class in edit_plan:
            # Phase 3: 背景色サンプリング
            bg_color = _sample_bg_color(page, expanded)
            page.add_redact_annot(expanded, fill=bg_color)

        if edit_plan:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

        # ── 新テキストを元の位置に挿入 ──
        for span_id, new_text, expanded, orig_rect, size_pt, writing_dir, font_class in edit_plan:
            try:
                # Phase 1: フォント解決
                fontfile = _resolve_font(font_class)
                font_kwargs: dict[str, Any] = {}
                if fontfile:
                    font_kwargs["fontfile"] = fontfile
                else:
                    font_kwargs["fontname"] = "japan"

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
                print(f"insert_text error: {e}")

        # ── 画像差し替え ──
        images_replaced = 0
        for img_id, new_img_data in image_replacements.items():
            try:
                xref = new_img_data.get("xref")
                new_b64 = new_img_data.get("data_b64", "")
                if not xref or not new_b64:
                    continue
                new_img_bytes = base64.b64decode(new_b64)
                # PyMuPDF で画像を差し替え
                doc._deleteObject(xref)
                page = doc.load_page(page_index)

                # 画像の位置を取得して再配置
                img_rect_data = new_img_data.get("rect")
                if img_rect_data:
                    img_rect = fitz.Rect(img_rect_data)
                    page.insert_image(img_rect, stream=new_img_bytes)
                    images_replaced += 1
                else:
                    # xrefベースで直接置換
                    try:
                        pix = fitz.Pixmap(new_img_bytes)
                        doc.replace_image(xref, pixmap=pix)
                        images_replaced += 1
                    except Exception:
                        # fallback: ページ上に画像を配置
                        img_rects = page.get_image_rects(xref)
                        if img_rects:
                            page.insert_image(img_rects[0], stream=new_img_bytes)
                            images_replaced += 1
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
        doc.close()

        return {
            "pdf_b64": base64.b64encode(
                new_pdf_bytes).decode("utf-8"),
            "png_b64": base64.b64encode(
                png_bytes).decode("utf-8"),
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
    """スパンデータからVivliostyle用HTML+CSSを生成"""
    w_mm, h_mm = page_mm[0], page_mm[1]

    font_map = {
        "gothic": "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
        "gothic_bold": (
            "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif"
        ),
        "mincho": "'Noto Serif JP', 'Hiragino Mincho ProN', serif",
        "light": "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
    }
    weight_map = {
        "gothic": "400",
        "gothic_bold": "700",
        "mincho": "400",
        "light": "300",
    }

    css = f"""@page {{
  size: {w_mm}mm {h_mm}mm;
  margin: 0;
  bleed: 3mm;
  marks: crop cross;
}}

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
        font_family = font_map.get(s.font_class, font_map["gothic"])
        font_weight = weight_map.get(s.font_class, "400")
        elements_html += (
            f'    <div class="span-element" style="'
            f"left: {s.x_pct}%; top: {s.y_pct}%; "
            f"font-family: {font_family}; font-weight: {font_weight}; "
            f'font-size: {s.size_pt}pt;">{s.text}</div>\n'
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

    html_content, css_content = _generate_html_css(
        req.spans, req.page_mm, req.title, req.bg_image_b64
    )
    tmpdir = tempfile.mkdtemp(prefix="vivliostyle_")

    try:
        html_path = os.path.join(tmpdir, "index.html")
        css_path = os.path.join(tmpdir, "style.css")
        pdf_path = os.path.join(tmpdir, "output.pdf")

        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_content)
        with open(css_path, "w", encoding="utf-8") as f:
            f.write(css_content)

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
    """md2pdf-ja 失敗時の Vivliostyle フォールバック"""
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

    css_content = f"""@page {{
  size: {w_mm}mm {h_mm}mm;
  margin: 10mm 12mm;
}}

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
  font-family: 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 10pt;
  line-height: 1.8;
  color: #222;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}

h1 {{ font-size: 20pt; margin: 0.5em 0 0.3em; font-weight: 700; }}
h2 {{ font-size: 16pt; margin: 0.4em 0 0.2em; font-weight: 700; }}
h3 {{ font-size: 13pt; margin: 0.3em 0 0.2em; font-weight: 600; }}

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
