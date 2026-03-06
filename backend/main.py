"""
名刺PDF前処理・再構築 API (Cloud Run)

POST /analyze  - PDF → テキスト座標・フォント抽出 + プレビュー画像 (複数ページ対応)
POST /rebuild  - テキスト修正 → 再構築PDF (JSON)
GET  /health   - ヘルスチェック
"""

import fitz  # PyMuPDF
import os
import re
import io
import json
import base64
import subprocess
import httpx
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

# ── Gemini Vision OCR ──
GOOGLE_AI_KEY = os.environ.get("GOOGLE_AI_KEY", "")
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

app = FastAPI(title="名刺作成し太郎 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Fonts ──

GOOGLE_FONT_DIR = "/usr/share/fonts/google"
LOCAL_FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
if not os.path.isdir(LOCAL_FONT_DIR):
    LOCAL_FONT_DIR = "/app/fonts"  # Docker環境

FONT_PATHS = {}          # gothic/mincho/light フォールバック用
FONT_INDEX = {}           # { family_key: { weight_key: filepath, ... }, ... }
FONT_FILE_INDEX = {}      # { normalized_filename: filepath }  完全一致用

# Weight keywords in priority order
_WEIGHT_REGULAR = ["roman", "regular", "book", "medium", "std", "55"]
_WEIGHT_BOLD = ["bold", "demi", "heavy", "semibold", "black", "65", "75"]
_WEIGHT_LIGHT = ["light", "thin", "extralight", "ultralight", "35", "45"]


def _normalize(name: str) -> str:
    """フォント名を正規化: 小文字化, 記号除去"""
    return re.sub(r'[-_\s.]+', '', name.lower())


def _detect_weight(filename_lower: str) -> str:
    """ファイル名からweight分類を推定"""
    for w in _WEIGHT_BOLD:
        if w in filename_lower:
            return "bold"
    for w in _WEIGHT_LIGHT:
        if w in filename_lower:
            return "light"
    return "regular"


def _build_font_index():
    """LOCAL_FONT_DIR を再帰スキャンしてフォントインデックスを構築"""
    global FONT_INDEX, FONT_FILE_INDEX
    FONT_INDEX = {}
    FONT_FILE_INDEX = {}

    if not os.path.isdir(LOCAL_FONT_DIR):
        print(f"  Local font dir not found: {LOCAL_FONT_DIR}")
        return

    for dirpath, _dirnames, filenames in os.walk(LOCAL_FONT_DIR):
        family_dir = os.path.basename(dirpath)
        family_key = _normalize(family_dir)

        for fn in filenames:
            if not fn.lower().endswith(('.ttf', '.otf')):
                continue
            full_path = os.path.join(dirpath, fn)
            stem = os.path.splitext(fn)[0]
            fn_norm = _normalize(stem)

            # ファイル名完全一致インデックス
            FONT_FILE_INDEX[fn_norm] = full_path

            # ファミリ + weight インデックス
            if family_key not in FONT_INDEX:
                FONT_INDEX[family_key] = {}
            weight = _detect_weight(fn.lower())
            # 同weightが既にあれば上書きしない (最初のものを優先)
            if weight not in FONT_INDEX[family_key]:
                FONT_INDEX[family_key][weight] = full_path

    print(f"  Font index: {len(FONT_INDEX)} families, {len(FONT_FILE_INDEX)} files")


def match_font(pdf_font_name: str, is_bold: bool = False) -> str | None:
    """PDFのフォント名からローカルフォントファイルをマッチング"""
    if not pdf_font_name or not FONT_INDEX:
        return None

    norm = _normalize(pdf_font_name)

    # 1. ファイル名完全一致 (正規化後)
    if norm in FONT_FILE_INDEX:
        return FONT_FILE_INDEX[norm]

    # 2. ファミリ名部分一致 — 長いキーを優先 (より具体的なマッチ)
    best_family = None
    best_len = 0
    for fkey, weights in FONT_INDEX.items():
        if fkey in norm and len(fkey) > best_len:
            best_family = weights
            best_len = len(fkey)

    if best_family:
        # weight選択
        if is_bold:
            for w in ["bold", "heavy", "demi", "black", "regular"]:
                if w in best_family:
                    return best_family[w]
        else:
            # PDF名自体にweightヒントがあればそれを使う
            detected = _detect_weight(norm)
            if detected in best_family:
                return best_family[detected]
            for w in ["regular", "light", "bold"]:
                if w in best_family:
                    return best_family[w]
        # 何かあれば返す
        return next(iter(best_family.values()))

    return None


def init_fonts():
    global FONT_PATHS

    # ローカルフォントインデックスを構築
    _build_font_index()

    # Noto フォント (日本語フォールバック)
    gf_sans = os.path.join(GOOGLE_FONT_DIR, "NotoSansJP.ttf")
    gf_serif = os.path.join(GOOGLE_FONT_DIR, "NotoSerifJP.ttf")

    if os.path.exists(gf_sans) and os.path.exists(gf_serif):
        FONT_PATHS = {
            "gothic":      gf_sans,
            "gothic_bold": gf_sans,
            "mincho":      gf_serif,
            "mincho_bold": gf_serif,
            "light":       gf_sans,
        }
        print("  Noto fallback: Google Fonts (Noto Sans JP / Noto Serif JP)")
    else:
        def find(pattern):
            r = subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True)
            p = r.stdout.strip()
            return p if os.path.exists(p) else None
        FONT_PATHS = {
            "gothic":      find("Noto Sans CJK JP:weight=regular"),
            "gothic_bold": find("Noto Sans CJK JP:weight=bold"),
            "mincho":      find("Noto Serif CJK JP:weight=regular"),
            "mincho_bold": find("Noto Serif CJK JP:weight=bold"),
            "light":       find("Noto Sans CJK JP:weight=light"),
        }
        print("  Noto fallback: system Noto CJK fonts")

    for k, v in FONT_PATHS.items():
        print(f"  Font [{k}]: {v}")

def classify_font(name: str) -> str:
    n = name.lower()
    if any(k in n for k in ["mincho", "明朝", "serif", "song", "ming",
                             "garamond", "times", "palatino", "cambria",
                             "georgia", "bodoni", "didot", "caslon"]):
        return "mincho"
    if any(k in n for k in ["light", "thin", "extralight", "ultralight"]):
        return "light"
    if any(k in n for k in ["bold", "heavy", "black"]):
        return "gothic_bold"
    return "gothic"


def _safe_color_int(span_color) -> int:
    """span["color"] がNoneや非intの場合に0を返す安全なヘルパー"""
    if span_color is None:
        return 0
    try:
        return int(span_color)
    except (TypeError, ValueError):
        return 0

# ── CID Text Cleaning ──

# ── Gemini Vision OCR ──

async def gemini_ocr(png_b64: str, region_w: float, region_h: float) -> list[dict] | None:
    """Gemini Vision API で名刺画像からテキストを読み取る"""
    if not GOOGLE_AI_KEY:
        print("  GOOGLE_AI_KEY not set — skipping Gemini OCR")
        return None

    prompt = """この名刺画像のすべてのテキストを読み取ってください。

各テキスト行について以下のJSON配列で返してください:
[
  {"text": "テキスト内容", "y_pct": 上からの位置(%), "x_pct": 左からの位置(%), "size_hint": "large|medium|small"}
]

ルール:
- 全てのテキストを正確に読む（文字間にスペースを入れない）
- 電話番号・FAX・メール・URLは正確にそのまま
- 人名の漢字は慎重に
- ロゴや装飾は無視
- テスト用の赤い数字は無視
- JSON配列のみ出力（他のテキスト不要）"""

    body = {
        "contents": [{
            "parts": [
                {"inlineData": {"mimeType": "image/png", "data": png_b64}},
                {"text": prompt},
            ],
        }],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 4000},
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f"{GEMINI_URL}?key={GOOGLE_AI_KEY}",
                json=body,
                headers={"Content-Type": "application/json"},
            )
        if res.status_code != 200:
            print(f"  Gemini OCR error {res.status_code}: {res.text[:200]}")
            return None
        data = res.json()
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        clean = re.sub(r'```json|```', '', text).strip()
        return json.loads(clean)
    except Exception as e:
        print(f"  Gemini OCR failed: {e}")
        return None


# ── PDF Analysis (Multi-Page) ──

async def analyze_page_region(doc, page_idx: int, clip_rect: list, label: str | None) -> dict:
    """1ページまたはクリップ領域を分析 — Gemini OCR + PyMuPDF dict"""
    page = doc[page_idx]
    cx0, cy0, cx1, cy1 = clip_rect
    region_w = cx1 - cx0
    region_h = cy1 - cy0
    clip = fitz.Rect(cx0, cy0, cx1, cy1)

    # ── 1. プレビュー画像 (Gemini OCR入力 + フロントエンド表示用) ──
    mat = fitz.Matrix(300 / 72, 300 / 72)
    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
    png_b64 = base64.b64encode(pix.tobytes("png")).decode()

    # ── 2. get_text("dict") — フォント / サイズ / 色 + raw span ID (rebuild互換) ──
    raw_font_spans = []
    raw_idx = 0
    for block in page.get_text("dict")["blocks"]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if not span["text"].strip():
                    continue
                bbox = span["bbox"]
                center_x = (bbox[0] + bbox[2]) / 2
                center_y = (bbox[1] + bbox[3]) / 2
                if cx0 <= center_x <= cx1 and cy0 <= center_y <= cy1:
                    raw_font_spans.append({
                        "id": f"p{page_idx}s{raw_idx}",
                        "bbox": bbox,
                        "font": span["font"],
                        "size": span["size"],
                        "color": span.get("color", 0),
                        "flags": span.get("flags", 0),
                        "origin": span["origin"],
                    })
                raw_idx += 1

    def _find_nearest_raw(y_pct: float, x_pct: float):
        """Geminiの位置(%)に最も近いraw spanを返す"""
        target_y = cy0 + region_h * y_pct / 100
        target_x = cx0 + region_w * x_pct / 100
        best, best_d = None, float('inf')
        for rs in raw_font_spans:
            rb = rs["bbox"]
            ry = (rb[1] + rb[3]) / 2
            rx = (rb[0] + rb[2]) / 2
            d = abs(ry - target_y) * 2 + abs(rx - target_x)
            if d < best_d:
                best_d, best = d, rs
        return best

    def _find_overlapping_raw_ids(y_pct: float, size_hint: str):
        """Y位置付近の全raw span IDを返す"""
        target_y = cy0 + region_h * y_pct / 100
        tolerance = region_h * 0.03  # 3%の許容範囲
        ids = []
        for rs in raw_font_spans:
            rb = rs["bbox"]
            ry = (rb[1] + rb[3]) / 2
            if abs(ry - target_y) < max(tolerance, (rb[3] - rb[1]) * 0.8):
                ids.append(rs["id"])
        return ids

    # ── 3. Gemini OCR でテキスト読み取り ──
    gemini_results = await gemini_ocr(png_b64, region_w, region_h)

    spans_out = []
    raw_id_map = {}

    if gemini_results:
        # Gemini OCR 成功 — AIの読み取り結果を使用
        for i, item in enumerate(gemini_results):
            text = item.get("text", "").strip()
            if not text:
                continue
            y_pct = float(item.get("y_pct", 0))
            x_pct = float(item.get("x_pct", 0))
            size_hint = item.get("size_hint", "medium")

            nearest = _find_nearest_raw(y_pct, x_pct)
            raw_ids = _find_overlapping_raw_ids(y_pct, size_hint)

            mid = f"m{len(spans_out)}"
            raw_id_map[mid] = raw_ids if raw_ids else [mid]

            if nearest:
                fi = nearest
                adj_bbox = [fi["bbox"][0] - cx0, fi["bbox"][1] - cy0, fi["bbox"][2] - cx0, fi["bbox"][3] - cy0]
                # 同じY行の全raw spanでbboxを拡張
                for rs in raw_font_spans:
                    if rs["id"] in raw_ids:
                        adj_bbox[0] = min(adj_bbox[0], rs["bbox"][0] - cx0)
                        adj_bbox[1] = min(adj_bbox[1], rs["bbox"][1] - cy0)
                        adj_bbox[2] = max(adj_bbox[2], rs["bbox"][2] - cx0)
                        adj_bbox[3] = max(adj_bbox[3], rs["bbox"][3] - cy0)
            else:
                fi = {"font": "unknown", "size": 10, "color": 0, "flags": 0, "origin": [cx0 + region_w * x_pct / 100, cy0 + region_h * y_pct / 100]}
                adj_bbox = [region_w * x_pct / 100, region_h * y_pct / 100, region_w * 0.9, region_h * y_pct / 100 + 12]

            fc = classify_font(fi.get("font", "unknown"))
            spans_out.append({
                "id": mid,
                "text": text,
                "font_original": fi.get("font", "unknown"),
                "font_class": fc,
                "size_pt": round(fi.get("size", 10), 2),
                "origin": [round(fi.get("origin", [0, 0])[0] - cx0, 2), round(fi.get("origin", [0, 0])[1] - cy0, 2)],
                "bbox": [round(x, 2) for x in adj_bbox],
                "x_pct": round(adj_bbox[0] / region_w * 100, 2) if region_w > 0 else 0,
                "y_pct": round(adj_bbox[1] / region_h * 100, 2) if region_h > 0 else 0,
                "w_pct": round((adj_bbox[2] - adj_bbox[0]) / region_w * 100, 2) if region_w > 0 else 0,
                "h_pct": round((adj_bbox[3] - adj_bbox[1]) / region_h * 100, 2) if region_h > 0 else 0,
            })
    else:
        # フォールバック: PyMuPDF get_text("words")
        words = page.get_text("words", clip=clip)
        line_groups = {}
        for w in words:
            x0, y0, x1, y1, text, blk, ln, _ = w
            key = (blk, ln)
            if key not in line_groups:
                line_groups[key] = []
            line_groups[key].append((x0, y0, x1, y1, text))

        for key in sorted(line_groups.keys()):
            line_words = sorted(line_groups[key], key=lambda w: w[0])
            text = " ".join(w[4] for w in line_words)
            if not text.strip():
                continue
            lx0 = min(w[0] for w in line_words)
            ly0 = min(w[1] for w in line_words)
            lx1 = max(w[2] for w in line_words)
            ly1 = max(w[3] for w in line_words)

            wmx, wmy = (lx0 + lx1) / 2, (ly0 + ly1) / 2
            fi_best, fi_d = None, float('inf')
            for rs in raw_font_spans:
                rb = rs["bbox"]
                d = abs((rb[0]+rb[2])/2 - wmx) + abs((rb[1]+rb[3])/2 - wmy)
                if d < fi_d:
                    fi_d, fi_best = d, rs
            fi = fi_best or {"font": "unknown", "size": 10, "color": 0, "flags": 0, "origin": [lx0, ly1]}

            adj_bbox = [lx0 - cx0, ly0 - cy0, lx1 - cx0, ly1 - cy0]
            mid = f"m{len(spans_out)}"
            ol_ids = [rs["id"] for rs in raw_font_spans if rs["bbox"][0] < lx1 and rs["bbox"][2] > lx0 and rs["bbox"][1] < ly1 and rs["bbox"][3] > ly0]
            raw_id_map[mid] = ol_ids if ol_ids else [mid]
            fc = classify_font(fi["font"])

            spans_out.append({
                "id": mid,
                "text": text.strip(),
                "font_original": fi["font"],
                "font_class": fc,
                "size_pt": round(fi["size"], 2),
                "origin": [round(fi["origin"][0] - cx0, 2), round(fi["origin"][1] - cy0, 2)],
                "bbox": [round(x, 2) for x in adj_bbox],
                "x_pct": round(adj_bbox[0] / region_w * 100, 2) if region_w > 0 else 0,
                "y_pct": round(adj_bbox[1] / region_h * 100, 2) if region_h > 0 else 0,
                "w_pct": round((adj_bbox[2] - adj_bbox[0]) / region_w * 100, 2) if region_w > 0 else 0,
                "h_pct": round((adj_bbox[3] - adj_bbox[1]) / region_h * 100, 2) if region_h > 0 else 0,
            })

    # 画像 (clip内)
    images = []
    for info in page.get_image_info():
        ibbox = info["bbox"]
        icx = (ibbox[0] + ibbox[2]) / 2
        icy = (ibbox[1] + ibbox[3]) / 2
        if cx0 <= icx <= cx1 and cy0 <= icy <= cy1:
            adj = [ibbox[0] - cx0, ibbox[1] - cy0, ibbox[2] - cx0, ibbox[3] - cy0]
            images.append({
                "id": f"img{len(images)}",
                "bbox": [round(x, 2) for x in adj],
            })

    # 装飾 (clip内)
    drawings = []
    for d in page.get_drawings():
        r = d["rect"]
        dcx = (r[0] + r[2]) / 2
        dcy = (r[1] + r[3]) / 2
        if cx0 <= dcx <= cx1 and cy0 <= dcy <= cy1:
            adj = [r[0] - cx0, r[1] - cy0, r[2] - cx0, r[3] - cy0]
            drawings.append({
                "bbox": [round(x, 2) for x in adj],
                "fill": [round(c, 3) for c in d["fill"]] if d.get("fill") else None,
                "color": [round(c, 3) for c in d["color"]] if d.get("color") else None,
            })

    # プレビュー画像 — Gemini OCR用に既に生成済みの png_b64 を再利用
    result = {
        "page_index": page_idx,
        "page_pt": [round(region_w, 1), round(region_h, 1)],
        "page_mm": [round(region_w / 72 * 25.4, 1), round(region_h / 72 * 25.4, 1)],
        "spans": spans_out,
        "raw_id_map": raw_id_map,
        "images": images,
        "drawings": drawings,
        "original_png_b64": png_b64,
        "ocr_source": "gemini" if gemini_results else "pymupdf",
        "clip_rect": [round(x, 1) for x in clip_rect],
    }
    if label:
        result["page_label"] = label
    return result


async def analyze_pdf(pdf_bytes: bytes) -> dict:
    """PDF全ページを分析"""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        pw, ph = page.rect.width, page.rect.height
        clip_rect = [0, 0, pw, ph]
        page_data = await analyze_page_region(doc, page_idx, clip_rect, None)
        pages.append(page_data)

    return {"pages": pages}


# ── PDF Rebuild ──

def rebuild_pdf(
    pdf_bytes: bytes,
    edits: dict,
    overrides: dict,
    raw_id_map: dict,
    page_index: int = 0,
    clip_rect: list | None = None,
    dpi: int = 300,
) -> tuple[bytes, bytes]:
    """
    オーバーレイ方式: 元PDFの編集箇所だけを白塗り→上書き。
    未編集の要素は元PDFそのまま保持 → レイアウト崩壊なし。
    overrides: { mid: { text?, font_class?, size_pt?, origin? } }
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if page_index >= len(doc):
        page_index = 0
    page = doc[page_index]
    pw, ph = page.rect.width, page.rect.height

    if clip_rect:
        cx0, cy0, cx1, cy1 = clip_rect
    else:
        cx0, cy0, cx1, cy1 = 0, 0, pw, ph

    region_w = cx1 - cx0
    region_h = cy1 - cy0

    # raw_id形式を検出 (後方互換: "s0" vs "p0s0")
    all_raw_ids = [rid for ids in raw_id_map.values() for rid in ids]
    use_page_prefix = any(rid.startswith("p") for rid in all_raw_ids)

    # Merge edits + overrides into a unified map: mid → { text, font_class, size_pt, origin }
    merged_overrides = {}
    for mid, new_text in edits.items():
        merged_overrides[mid] = {"text": new_text}
    for mid, ov in overrides.items():
        if mid not in merged_overrides:
            merged_overrides[mid] = {}
        if isinstance(ov, dict):
            merged_overrides[mid].update(ov)
        else:
            # Pydantic model
            if ov.text is not None:
                merged_overrides[mid]["text"] = ov.text
            if ov.font_class is not None:
                merged_overrides[mid]["font_class"] = ov.font_class
            if ov.size_pt is not None:
                merged_overrides[mid]["size_pt"] = ov.size_pt
            if ov.origin is not None:
                merged_overrides[mid]["origin"] = ov.origin

    # raw_id → override のマッピング (テキスト編集: first raw gets text, rest get "")
    raw_edits = {}       # raw_id → new_text | ""
    raw_overrides = {}   # raw_id → { font_class?, size_pt?, origin? }
    for mid, ov_data in merged_overrides.items():
        raw_ids = raw_id_map.get(mid, [mid])
        new_text = ov_data.get("text")
        extra = {k: v for k, v in ov_data.items() if k != "text"}
        if raw_ids:
            if new_text is not None:
                raw_edits[raw_ids[0]] = new_text
                for rid in raw_ids[1:]:
                    raw_edits[rid] = ""
            if extra:
                raw_overrides[raw_ids[0]] = extra

    # フォントキャッシュ
    fonts_cache = {}
    def get_font(fc, is_bold=False, original_font_name=None):
        # 1. ローカルフォントマッチング (元のフォント名から直接検索)
        if original_font_name:
            cache_key = f"local:{_normalize(original_font_name)}:{is_bold}"
            if cache_key not in fonts_cache:
                matched = match_font(original_font_name, is_bold)
                if matched:
                    try:
                        fonts_cache[cache_key] = fitz.Font(fontfile=matched)
                    except Exception:
                        fonts_cache[cache_key] = None
                else:
                    fonts_cache[cache_key] = None
            if fonts_cache[cache_key] is not None:
                return fonts_cache[cache_key]

        # 2. フォールバック: Noto フォント (日本語対応)
        if is_bold and fc in ("gothic", "light"):
            fc = "gothic_bold"
        key = f"noto:{fc}"
        if key not in fonts_cache:
            path = FONT_PATHS.get(fc) or FONT_PATHS.get("gothic")
            fonts_cache[key] = fitz.Font(fontfile=path)
        return fonts_cache[key]

    # Collect all affected raw_ids (text edits OR overrides)
    affected_ids = set(raw_edits.keys()) | set(raw_overrides.keys())

    # === Pass 1: Redaction — 編集箇所の元テキストを除去 (画像は保持) ===
    draw_tasks = []
    
    # Process existing spans for redaction
    span_idx = 0
    for block in page.get_text("dict")["blocks"]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if not span["text"].strip():
                    continue
                if use_page_prefix:
                    sid = f"p{page_index}s{span_idx}"
                else:
                    sid = f"s{span_idx}"

                if sid in affected_ids:
                    bbox = fitz.Rect(span["bbox"])
                    # Shrink the bbox slightly to prevent redaction from accidentally deleting neighboring lines.
                    # PyMuPDF removes any text intersecting the redact rect. A slightly smaller box is safer.
                    h = bbox.height
                    w = bbox.width
                    if h > 0 and w > 0:
                        bbox = bbox + (w * 0.05, h * 0.15, -w * 0.05, -h * 0.15)
                    
                    # fill=False → 背景を塗りつぶさず、テキストだけ除去
                    page.add_redact_annot(bbox, fill=False)

                    # Determine text: edited or original
                    if sid in raw_edits:
                        new_text = raw_edits[sid]
                    else:
                        new_text = span["text"]

                    if new_text:
                        sc = _safe_color_int(span.get("color", 0))
                        txt_color = (
                            ((sc >> 16) & 0xFF) / 255,
                            ((sc >> 8) & 0xFF) / 255,
                            (sc & 0xFF) / 255,
                        )
                        # flags: bit 4 (16) = bold, bit 1 (2) = italic
                        span_flags = span.get("flags", 0) or 0
                        is_bold = bool(span_flags & 16)
                        ov = raw_overrides.get(sid, {})
                        draw_tasks.append({
                            "origin": ov.get("origin", span["origin"]),
                            "text": new_text,
                            "font_class": ov.get("font_class", classify_font(span["font"])),
                            "size": ov.get("size_pt", span["size"]),
                            "color": txt_color,
                            "is_bold": is_bold,
                            "original_font": span["font"],
                        })

                span_idx += 1

    # Add completely new spans (added via AI chat) that don't map to existing raw_ids
    for mid, ov_data in merged_overrides.items():
        # New spans often don't have a mapping in raw_id_map, or they map to their own new ID
        is_new = mid not in raw_id_map or not any(rid.startswith("p") or rid.startswith("s") for rid in raw_id_map[mid])
        if is_new and ov_data.get("text"):
            draw_tasks.append({
                "origin": ov_data.get("origin", [0, 0]),
                "text": ov_data.get("text"),
                "font_class": ov_data.get("font_class", "gothic"),
                "size": ov_data.get("size_pt", 12.0),
                "color": (0, 0, 0),  # Default black for new text
                "is_bold": "bold" in ov_data.get("font_class", ""),
                "original_font": None,
            })

    # Redaction を適用 (テキストのみ除去、画像は保持)
    try:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_GRAPHICS_NONE)
    except (TypeError, AttributeError):
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    # === Pass 2: 新テキストを描画 ===
    for task in draw_tasks:
        tw = fitz.TextWriter(page.rect)
        tw.append(
            fitz.Point(task["origin"][0], task["origin"][1]),
            task["text"],
            font=get_font(task["font_class"], task.get("is_bold", False), task.get("original_font")),
            fontsize=task["size"],
        )
        tw.write_text(page, color=task["color"])

    # プレビューPNG (修正済みページから直接レンダリング)
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    clip = fitz.Rect(cx0, cy0, cx1, cy1)
    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
    png_bytes = pix.tobytes("png")

    # ベクターPDF出力: 対象ページのみ残してsave
    doc.select([page_index])
    pdf_buf = io.BytesIO()
    doc.save(pdf_buf, garbage=4, deflate=True)

    return pdf_buf.getvalue(), png_bytes


# ── Endpoints ──

class SpanOverride(BaseModel):
    text: Optional[str] = None
    font_class: Optional[str] = None
    size_pt: Optional[float] = None
    origin: Optional[list[float]] = None

class RebuildRequest(BaseModel):
    pdf_b64: str
    page_index: int = 0
    clip_rect: Optional[list[float]] = None
    edits: dict = {}
    overrides: dict[str, SpanOverride] = {}
    raw_id_map: dict = {}
    dpi: int = 300

@app.on_event("startup")
def startup():
    init_fonts()

@app.get("/health")
def health():
    return {
        "status": "ok",
        "fonts": {k: bool(v) for k, v in FONT_PATHS.items()},
        "local_font_families": len(FONT_INDEX),
        "local_font_files": len(FONT_FILE_INDEX),
        "gemini_ocr": bool(GOOGLE_AI_KEY),
    }

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDFファイルのみ対応")
    pdf_bytes = await file.read()
    try:
        result = await analyze_pdf(pdf_bytes)
    except Exception as e:
        raise HTTPException(500, f"PDF分析エラー: {e}")
    result["pdf_b64"] = base64.b64encode(pdf_bytes).decode()
    return result

@app.post("/rebuild")
async def rebuild(req: RebuildRequest):
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64)
    except Exception as e:
        raise HTTPException(400, f"入力エラー: {e}")
    try:
        pdf_out, png_out = rebuild_pdf(
            pdf_bytes, req.edits, req.overrides,
            req.raw_id_map, req.page_index, req.clip_rect, req.dpi,
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"再構築エラー: {e}")
    return {
        "pdf_b64": base64.b64encode(pdf_out).decode(),
        "png_b64": base64.b64encode(png_out).decode(),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
