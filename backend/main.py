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
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="名刺マネージャー API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Fonts ──

GOOGLE_FONT_DIR = "/usr/share/fonts/google"
FONT_PATHS = {}

def init_fonts():
    global FONT_PATHS

    # Prefer Google Fonts (Noto Sans JP / Noto Serif JP) downloaded in Dockerfile
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
        print("  Using Google Fonts (Noto Sans JP / Noto Serif JP)")
    else:
        # Fallback: system fonts-noto-cjk
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
        print("  Fallback: system Noto CJK fonts")

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

def _clean_cid_text(text: str) -> str:
    """CIDフォント由来の文字間スペースを除去"""
    if not text or ' ' not in text:
        return text
    space_ratio = text.count(' ') / max(len(text), 1)
    if space_ratio > 0.25:
        text = text.replace(' ', '')
    return text.strip()

# ── Span Merging ──

def merge_line_spans(raw_spans: list) -> list:
    """
    PyMuPDF の get_text("dict") はCIDフォントで1文字ずつ別spanになる。
    同一行内の隣接spanを結合して、意味のある単位にする。
    """
    if not raw_spans:
        return []

    sorted_spans = sorted(raw_spans, key=lambda s: (s["bbox"][1], s["bbox"][0]))
    lines = []
    cur_line = [sorted_spans[0]]

    for s in sorted_spans[1:]:
        prev = cur_line[-1]
        prev_mid_y = (prev["bbox"][1] + prev["bbox"][3]) / 2
        prev_h = prev["bbox"][3] - prev["bbox"][1]
        cur_mid_y = (s["bbox"][1] + s["bbox"][3]) / 2
        if abs(cur_mid_y - prev_mid_y) < max(prev_h * 0.6, 2.5):
            cur_line.append(s)
        else:
            lines.append(cur_line)
            cur_line = [s]
    lines.append(cur_line)

    merged = []
    for line in lines:
        line_sorted = sorted(line, key=lambda s: s["bbox"][0])
        group = [line_sorted[0]]

        for s in line_sorted[1:]:
            prev = group[-1]
            gap = s["bbox"][0] - prev["bbox"][2]
            prev_char_w = (prev["bbox"][2] - prev["bbox"][0]) / max(len(prev["text"].strip()), 1)
            threshold = max(prev_char_w * 4, 3.0)
            if gap < threshold:
                group.append(s)
            else:
                merged.append(_combine_group(group))
                group = [s]
        merged.append(_combine_group(group))

    return merged


def _combine_group(group: list) -> dict:
    """複数のraw spanを1つに結合"""
    if len(group) == 1:
        g = group[0]
        g["text"] = g["text"].strip()
        return g

    single_char = sum(1 for s in group if len(s["text"].strip()) <= 1)
    is_cid = single_char > len(group) * 0.4

    if is_cid:
        text = "".join(s["text"].strip() for s in group)
    else:
        text = "".join(s["text"] for s in group)

    text = _clean_cid_text(text)

    x0 = min(s["bbox"][0] for s in group)
    y0 = min(s["bbox"][1] for s in group)
    x1 = max(s["bbox"][2] for s in group)
    y1 = max(s["bbox"][3] for s in group)
    main = max(group, key=lambda s: s["size"])
    return {
        "text": text,
        "font": main["font"],
        "size": main["size"],
        "origin": group[0]["origin"],
        "bbox": [x0, y0, x1, y1],
        "_raw_ids": [s.get("_raw_id", s.get("id")) for s in group],
    }


# ── PDF Analysis (Multi-Page) ──

def analyze_page_region(doc, page_idx: int, clip_rect: list, label: str | None) -> dict:
    """1ページまたはクリップ領域を分析"""
    page = doc[page_idx]
    cx0, cy0, cx1, cy1 = clip_rect
    region_w = cx1 - cx0
    region_h = cy1 - cy0

    # raw span抽出 (ページ全体をイテレート、clip内のみ収集)
    raw_spans = []
    raw_idx = 0
    for block in page.get_text("dict")["blocks"]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                txt = span["text"]
                if not txt.strip():
                    continue
                bbox = list(span["bbox"])
                center_x = (bbox[0] + bbox[2]) / 2
                center_y = (bbox[1] + bbox[3]) / 2
                if cx0 <= center_x <= cx1 and cy0 <= center_y <= cy1:
                    raw_spans.append({
                        "_raw_id": f"p{page_idx}s{raw_idx}",
                        "text": txt,
                        "font": span["font"],
                        "size": span["size"],
                        "origin": [span["origin"][0] - cx0, span["origin"][1] - cy0],
                        "bbox": [bbox[0] - cx0, bbox[1] - cy0, bbox[2] - cx0, bbox[3] - cy0],
                    })
                raw_idx += 1

    # 結合
    merged = merge_line_spans(raw_spans) if raw_spans else []

    # 出力整形 (ノイズ除去)
    spans_out = []
    raw_id_map = {}
    for m in merged:
        text = m["text"].strip()
        if len(text) == 0:
            continue
        if len(text) == 1 and not any('\u4e00' <= c <= '\u9fff' for c in text):
            continue

        mid = f"m{len(spans_out)}"
        bbox = m["bbox"]
        raw_ids = m.get("_raw_ids", [m.get("_raw_id", mid)])
        raw_id_map[mid] = raw_ids
        fc = classify_font(m["font"])
        spans_out.append({
            "id": mid,
            "text": text,
            "font_original": m["font"],
            "font_class": fc,
            "size_pt": round(m["size"], 2),
            "origin": [round(m["origin"][0], 2), round(m["origin"][1], 2)],
            "bbox": [round(x, 2) for x in bbox],
            "x_pct": round(bbox[0] / region_w * 100, 2) if region_w > 0 else 0,
            "y_pct": round(bbox[1] / region_h * 100, 2) if region_h > 0 else 0,
            "w_pct": round((bbox[2] - bbox[0]) / region_w * 100, 2) if region_w > 0 else 0,
            "h_pct": round((bbox[3] - bbox[1]) / region_h * 100, 2) if region_h > 0 else 0,
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

    # プレビュー画像 (clip region)
    mat = fitz.Matrix(300 / 72, 300 / 72)
    clip = fitz.Rect(cx0, cy0, cx1, cy1)
    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
    preview_b64 = base64.b64encode(pix.tobytes("png")).decode()

    result = {
        "page_index": page_idx,
        "page_pt": [round(region_w, 1), round(region_h, 1)],
        "page_mm": [round(region_w / 72 * 25.4, 1), round(region_h / 72 * 25.4, 1)],
        "spans": spans_out,
        "raw_id_map": raw_id_map,
        "images": images,
        "drawings": drawings,
        "original_png_b64": preview_b64,
        "clip_rect": [round(x, 1) for x in clip_rect],
    }
    if label:
        result["page_label"] = label
    return result


def analyze_pdf(pdf_bytes: bytes) -> dict:
    """PDF全ページを分析"""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        pw, ph = page.rect.width, page.rect.height
        clip_rect = [0, 0, pw, ph]
        page_data = analyze_page_region(doc, page_idx, clip_rect, None)
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
    def get_font(fc):
        if fc not in fonts_cache:
            path = FONT_PATHS.get(fc) or FONT_PATHS.get("gothic")
            fonts_cache[fc] = fitz.Font(fontfile=path)
        return fonts_cache[fc]

    # Collect all affected raw_ids (text edits OR overrides)
    affected_ids = set(raw_edits.keys()) | set(raw_overrides.keys())

    # === Pass 1: Redaction — 編集箇所の元テキストを除去 (画像は保持) ===
    draw_tasks = []
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
                    page.add_redact_annot(bbox, fill=(1, 1, 1))

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
                        ov = raw_overrides.get(sid, {})
                        draw_tasks.append({
                            "origin": ov.get("origin", span["origin"]),
                            "text": new_text,
                            "font_class": ov.get("font_class", classify_font(span["font"])),
                            "size": ov.get("size_pt", span["size"]),
                            "color": txt_color,
                        })

                span_idx += 1

    # Redaction を適用 (テキストのみ除去、画像は保持)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    # === Pass 2: 新テキストを描画 ===
    for task in draw_tasks:
        tw = fitz.TextWriter(page.rect)
        tw.append(
            fitz.Point(task["origin"][0], task["origin"][1]),
            task["text"], font=get_font(task["font_class"]),
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
    return {"status": "ok", "fonts": {k: bool(v) for k, v in FONT_PATHS.items()}}

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDFファイルのみ対応")
    pdf_bytes = await file.read()
    try:
        result = analyze_pdf(pdf_bytes)
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
