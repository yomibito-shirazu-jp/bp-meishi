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
あなたは印刷・組版の専門家です。この名刺・カード画像からすべてのテキスト要素を抽出し、
以下のJSON配列のみを返してください（コードブロック不要）。

各要素:
{
  "text": "テキスト内容",
  "font_class": "gothic" | "mincho" | "gothic_bold" | "light",
  "size_pt": 推定フォントサイズ(pt、数値),
  "x_pct": 左端の位置(0〜100の%),
  "y_pct": 上端の位置(0〜100の%),
  "w_pct": 幅(0〜100の%),
  "h_pct": 高さ(0〜100の%)
}

ルール:
- x_pct, y_pct, w_pct, h_pct は画像全体を100×100として正規化した座標
- font_class: 游明朝・ヒラギノ明朝系→"mincho", それ以外→"gothic" or "gothic_bold"
- size_pt: 本文≒8〜10pt, 氏名≒12〜16pt, 会社名≒11〜14pt を目安に推定
- 空文字のテキストは含めない
- JSON配列のみを出力（他の文字は一切含めない）
"""


def _extract_spans_gemini(
    png_bytes: bytes,
    page_w_pt: float,
    page_h_pt: float,
    api_key: str = None,
) -> list[dict[str, Any]]:
    """Gemini 2.0 Flash で PNG → Span リストを抽出"""
    active_key = api_key or GEMINI_API_KEY
    if not active_key:
        print("Error: Gemini API key is not set.")
        return []

    try:
        genai.configure(api_key=active_key)
        model = genai.GenerativeModel("gemini-2.0-flash")
        img_part = {
            "mime_type": "image/png",
            "data": base64.b64encode(png_bytes).decode(),
        }
        response = model.generate_content([GEMINI_EXTRACT_PROMPT, img_part])
        raw = response.text.strip()
    except Exception as e:
        print(f"Gemini API Error: {e}")
        return []

    # JSON ブロック除去
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(
            line for line in lines
            if not line.startswith("```")
        )

    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        print(f"Gemini JSON parse error. raw={raw[:200]}")
        return []

    spans = []
    for i, item in enumerate(items):
        if not item.get("text", "").strip():
            continue
        try:
            x_pct = float(item.get("x_pct", 0))
            y_pct = float(item.get("y_pct", 0))
            w_pct = float(item.get("w_pct", 20))
            h_pct = float(item.get("h_pct", 5))
            size_pt = float(item.get("size_pt", 10))
        except (ValueError, TypeError):
            continue

        # 絶対座標 (bbox) を pt 単位で計算
        bx = (x_pct / 100) * page_w_pt
        by = (y_pct / 100) * page_h_pt
        bw = (w_pct / 100) * page_w_pt
        bh = (h_pct / 100) * page_h_pt

        spans.append({
            "id": f"s_{int(time.time() * 1000)}_{i}",
            "text": item["text"].strip(),
            "font_original": "Gemini_Extracted",
            "font_class": item.get("font_class", "gothic"),
            "size_pt": size_pt,
            "origin": [bx, by + bh],
            "bbox": [bx, by, bw, bh],
            "x_pct": x_pct,
            "y_pct": y_pct,
            "w_pct": w_pct,
            "h_pct": h_pct,
        })

    return spans


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

        # モード選択: Document AI  "false"→無効  "force"→テキスト有無問わず強制  それ以外→テキスト無し時のみ
        use_docai_mode = (x_use_documentai or "").lower()
        use_docai = (use_docai_mode != "false")
        force_docai = (use_docai_mode == "force")

        docai_results: list[dict[str, Any]] = []
        if use_docai and (not has_text or force_docai):
            prj = x_project_id or os.environ.get("VITE_GOOGLE_PROJECT_ID", "270124753853")
            loc = x_location or os.environ.get("VITE_DOCUMENT_AI_LOCATION", "us")
            proc = x_processor_id or os.environ.get("VITE_DOCUMENT_AI_PROCESSOR_ID", "57695b373b653f96")
            ver = x_version_id or os.environ.get("VITE_DOCUMENT_AI_VERSION_ID")
            mode_label = "FORCE" if force_docai else "OCR"
            print(f"Using Document AI {mode_label} ({prj}, {loc}, {proc}, {ver})...")
            try:
                docai_results = _extract_spans_documentai(
                    pdf_bytes, prj, loc, proc, ver)
                print(f"Document AI extracted {len(docai_results)} pages")
            except Exception as docai_err:
                print(f"Document AI failed, falling back to Gemini: {docai_err}")
                docai_results = []
        elif has_text:
            print("PDF has embedded text. Skipping Document AI OCR.")

        for i in range(len(pdf_doc)):
            page = pdf_doc.load_page(i)
            rect = page.rect
            width_mm = rect.width * 0.352778
            height_mm = rect.height * 0.352778

            # 高解像度 PNG に変換
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            png_bytes = pix.tobytes("png")
            original_png_b64 = base64.b64encode(png_bytes).decode("utf-8")

            # Document AI レイアウト情報
            docai_layout_blocks = []
            docai_barcodes = []
            docai_languages = []

            if use_docai and i < len(docai_results):
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
            else:
                # Fallback to Gemini
                spans = _extract_spans_gemini(
                    png_bytes,
                    rect.width,
                    rect.height,
                    api_key=x_gemini_api_key
                )

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


# ── /rebuild エンドポイント ────────────────────────────────────────────────────

@app.post("/rebuild")
async def rebuild_pdf(req: dict[str, Any]):
    """PyMuPD でテキストを置換して修正PDF + プレビュー PNG を返す"""
    pdf_b64 = req.get("pdf_b64", "")
    edits = req.get("edits", {})
    original_texts = req.get("original_texts", {})
    overrides = req.get("overrides", {})
    image_replacements = req.get("image_replacements", {})
    page_index = req.get("page_index", 0)
    dpi = req.get("dpi", 300)

    if not pdf_b64:
        raise HTTPException(400, "pdf_b64 is required")

    try:
        pdf_bytes = base64.b64decode(pdf_b64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page = doc.load_page(page_index)

        changes_applied = 0
        for span_id, new_text in edits.items():
            old_text = original_texts.get(span_id, "")
            if not old_text or old_text == new_text:
                continue

            rects = page.search_for(old_text)
            if not rects:
                # 部分一致を試行（日本語は空白分割が効かないので文字単位）
                for word in old_text.split():
                    if len(word) >= 2:
                        rects = page.search_for(word)
                        if rects:
                            break
                # さらに文字単位で試行
                if not rects and len(old_text) >= 3:
                    for start in range(len(old_text) - 2):
                        chunk = old_text[start:start+3]
                        rects = page.search_for(chunk)
                        if rects:
                            break

            # bbox座標フォールバック（overridesにorigin/bbox情報がある場合）
            if not rects:
                ov = overrides.get(span_id, {})
                origin = ov.get("origin")
                if origin and len(origin) >= 2:
                    # originはページ座標 [x, y_bottom]
                    size_pt_fb = ov.get("size_pt", 9.0)
                    est_width = len(old_text) * size_pt_fb * 0.7
                    rect_fb = fitz.Rect(
                        origin[0], origin[1] - size_pt_fb * 1.3,
                        origin[0] + est_width, origin[1] + 2
                    )
                    rects = [rect_fb]
                    print(f"Using bbox fallback for: '{old_text[:20]}...'")

            if not rects:
                print(f"Text not found (all methods): '{old_text[:30]}'")
                continue

            rect = rects[0]
            ov = overrides.get(span_id, {})
            size_pt = ov.get("size_pt", 9.0)

            # 元テキストを消去して白塗り
            page.add_redact_annot(rect, fill=(1, 1, 1))
            page.apply_redactions()

            # 新テキストを挿入
            try:
                page.insert_text(
                    fitz.Point(rect.x0, rect.y1 - 1),
                    new_text,
                    fontname="japan",
                    fontsize=size_pt,
                    color=(0, 0, 0),
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8080)),
    )
