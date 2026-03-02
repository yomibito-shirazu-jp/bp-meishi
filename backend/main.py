"""
名刺PDF前処理・再構築 API (Cloud Run)

POST /analyze  - PDF → テキスト座標・フォント抽出 + プレビュー画像
POST /rebuild  - テキスト修正 → 再構築PDF
GET  /health   - ヘルスチェック
"""

import fitz  # PyMuPDF
import os
import io
import json
import base64
import subprocess
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="名刺マネージャー API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Fonts ──

FONT_PATHS = {}

def init_fonts():
    global FONT_PATHS
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
    for k, v in FONT_PATHS.items():
        print(f"  Font [{k}]: {v}")

def classify_font(name: str) -> str:
    n = name.lower()
    if any(k in n for k in ["mincho", "明朝", "serif", "song", "ming"]):
        return "mincho"
    if any(k in n for k in ["garamond", "times", "palatino", "light", "thin"]):
        return "light"
    if any(k in n for k in ["bold", "heavy", "black"]):
        return "gothic_bold"
    return "gothic"

# ── Span Merging ──

def merge_line_spans(raw_spans: list) -> list:
    """
    PyMuPDF の get_text("dict") はCIDフォントで1文字ずつ別spanになる。
    同一行内の隣接spanを結合して、意味のある単位にする。
    """
    if not raw_spans:
        return []

    # 行ごとにグルーピング (Y座標の近さで判定)
    sorted_spans = sorted(raw_spans, key=lambda s: (s["bbox"][1], s["bbox"][0]))
    lines = []
    cur_line = [sorted_spans[0]]

    for s in sorted_spans[1:]:
        prev = cur_line[-1]
        prev_mid_y = (prev["bbox"][1] + prev["bbox"][3]) / 2
        prev_h = prev["bbox"][3] - prev["bbox"][1]
        cur_mid_y = (s["bbox"][1] + s["bbox"][3]) / 2
        # 同一行判定: Y中心の差がline高さの50%以内
        if abs(cur_mid_y - prev_mid_y) < max(prev_h * 0.5, 2.0):
            cur_line.append(s)
        else:
            lines.append(cur_line)
            cur_line = [s]
    lines.append(cur_line)

    # 各行内で隣接span結合
    merged = []
    for line in lines:
        line_sorted = sorted(line, key=lambda s: s["bbox"][0])
        group = [line_sorted[0]]

        for s in line_sorted[1:]:
            prev = group[-1]
            gap = s["bbox"][0] - prev["bbox"][2]  # 右端→次の左端
            prev_char_w = (prev["bbox"][2] - prev["bbox"][0]) / max(len(prev["text"]), 1)
            # 結合条件: gap < 文字幅の3倍 or 2pt以内
            threshold = max(prev_char_w * 3, 2.0)
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
        return group[0]

    text = "".join(s["text"] for s in group)
    # bbox = 全体の外接矩形
    x0 = min(s["bbox"][0] for s in group)
    y0 = min(s["bbox"][1] for s in group)
    x1 = max(s["bbox"][2] for s in group)
    y1 = max(s["bbox"][3] for s in group)
    # 最大サイズのspanからフォント情報を取る
    main = max(group, key=lambda s: s["size"])
    return {
        "text": text,
        "font": main["font"],
        "size": main["size"],
        "origin": group[0]["origin"],  # 先頭spanの書き出し位置
        "bbox": [x0, y0, x1, y1],
        # 結合元のraw span ID一覧 (rebuild用)
        "_raw_ids": [s.get("_raw_id", s.get("id")) for s in group],
    }


# ── PDF Analysis ──

def analyze_pdf(pdf_bytes: bytes) -> dict:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[0]
    pw, ph = page.rect.width, page.rect.height

    # Step 1: raw span抽出
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
                raw_spans.append({
                    "_raw_id": f"s{raw_idx}",
                    "text": txt,
                    "font": span["font"],
                    "size": span["size"],
                    "origin": span["origin"],
                    "bbox": list(span["bbox"]),
                })
                raw_idx += 1

    # Step 2: 結合
    merged = merge_line_spans(raw_spans)

    # Step 3: 出力用に整形
    spans_out = []
    raw_id_map = {}  # merged_id → [raw_id, ...]
    for i, m in enumerate(merged):
        mid = f"m{i}"
        bbox = m["bbox"]
        raw_ids = m.get("_raw_ids", [m.get("_raw_id", mid)])
        raw_id_map[mid] = raw_ids
        fc = classify_font(m["font"])
        spans_out.append({
            "id": mid,
            "text": m["text"].strip(),
            "font_original": m["font"],
            "font_class": fc,
            "size_pt": round(m["size"], 2),
            "origin": [round(m["origin"][0], 2), round(m["origin"][1], 2)],
            "bbox": [round(x, 2) for x in bbox],
            "x_pct": round(bbox[0] / pw * 100, 2),
            "y_pct": round(bbox[1] / ph * 100, 2),
            "w_pct": round((bbox[2] - bbox[0]) / pw * 100, 2),
            "h_pct": round((bbox[3] - bbox[1]) / ph * 100, 2),
        })

    images = []
    for info in page.get_image_info():
        bbox = info["bbox"]
        images.append({
            "id": f"img{len(images)}",
            "bbox": [round(x, 2) for x in bbox],
        })

    drawings = []
    for d in page.get_drawings():
        r = d["rect"]
        drawings.append({
            "bbox": [round(x, 2) for x in [r[0], r[1], r[2], r[3]]],
            "fill": [round(c, 3) for c in d["fill"]] if d.get("fill") else None,
            "color": [round(c, 3) for c in d["color"]] if d.get("color") else None,
        })

    mat = fitz.Matrix(300 / 72, 300 / 72)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    original_b64 = base64.b64encode(pix.tobytes("png")).decode()

    return {
        "page_pt": [round(pw, 1), round(ph, 1)],
        "page_mm": [round(pw / 72 * 25.4, 1), round(ph / 72 * 25.4, 1)],
        "spans": spans_out,
        "raw_id_map": raw_id_map,
        "images": images,
        "drawings": drawings,
        "original_png_b64": original_b64,
    }


# ── PDF Rebuild ──

def rebuild_pdf(pdf_bytes: bytes, edits: dict, raw_id_map: dict, dpi: int = 300) -> tuple[bytes, bytes]:
    """
    edits: { merged_id: new_text }
    raw_id_map: { merged_id: [raw_id, ...] }
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[0]
    pw, ph = page.rect.width, page.rect.height

    # raw_id → 編集テキスト のマッピングを構築
    raw_edits = {}
    for mid, new_text in edits.items():
        raw_ids = raw_id_map.get(mid, [mid])
        if raw_ids:
            # 先頭のraw spanに全テキストを割当、残りは空文字
            raw_edits[raw_ids[0]] = new_text
            for rid in raw_ids[1:]:
                raw_edits[rid] = ""

    new_doc = fitz.open()
    new_page = new_doc.new_page(width=pw, height=ph)

    # 装飾
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"])
        fill = tuple(d["fill"]) if d.get("fill") else None
        color = tuple(d["color"]) if d.get("color") else None
        if fill or color:
            new_page.draw_rect(r, fill=fill, color=color, width=d.get("width", 0))

    # 画像
    img_list = page.get_images()
    img_infos = page.get_image_info()
    for i, info in enumerate(img_infos):
        if i < len(img_list):
            try:
                base_img = doc.extract_image(img_list[i][0])
                new_page.insert_image(fitz.Rect(*info["bbox"]), stream=base_img["image"])
            except Exception as e:
                print(f"  Image warning: {e}")

    # テキスト
    fonts_cache = {}
    def get_font(fc):
        if fc not in fonts_cache:
            path = FONT_PATHS.get(fc) or FONT_PATHS.get("gothic")
            fonts_cache[fc] = fitz.Font(fontfile=path)
        return fonts_cache[fc]

    span_idx = 0
    for block in page.get_text("dict")["blocks"]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if not span["text"].strip():
                    continue
                sid = f"s{span_idx}"
                final_text = raw_edits.get(sid, span["text"])
                if final_text:  # 空文字は描画しない
                    fc = classify_font(span["font"])
                    tw = fitz.TextWriter(new_page.rect)
                    tw.append(
                        fitz.Point(span["origin"][0], span["origin"][1]),
                        final_text, font=get_font(fc), fontsize=span["size"],
                    )
                    tw.write_text(new_page, color=(0, 0, 0))
                span_idx += 1

    # 画像ベースPDF
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = new_page.get_pixmap(matrix=mat, alpha=False)
    png_bytes = pix.tobytes("png")

    img_doc = fitz.open()
    img_page = img_doc.new_page(width=pw, height=ph)
    img_page.insert_image(fitz.Rect(0, 0, pw, ph), pixmap=pix)
    pdf_buf = io.BytesIO()
    img_doc.save(pdf_buf, garbage=4, deflate=True)

    return pdf_buf.getvalue(), png_bytes


# ── Endpoints ──

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
async def rebuild(
    pdf_b64: str = Form(...),
    edits_json: str = Form(default="{}"),
    raw_id_map_json: str = Form(default="{}"),
    dpi: int = Form(default=300),
):
    try:
        pdf_bytes = base64.b64decode(pdf_b64)
        edits = json.loads(edits_json)
        raw_id_map = json.loads(raw_id_map_json)
    except Exception as e:
        raise HTTPException(400, f"入力エラー: {e}")
    try:
        pdf_out, png_out = rebuild_pdf(pdf_bytes, edits, raw_id_map, dpi)
    except Exception as e:
        raise HTTPException(500, f"再構築エラー: {e}")
    return {
        "pdf_b64": base64.b64encode(pdf_out).decode(),
        "png_b64": base64.b64encode(png_out).decode(),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
