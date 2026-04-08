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
import google.generativeai as genai
from fastapi import FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google.cloud import documentai
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
                              version_id: Optional[str] = None) -> list[list[dict[str,
                                                                                  Any]]]:
    """Document AI で PDF 全体から Span 抽出 (チャンク処理対応)"""
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

    all_pages_spans = []

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
            # エラー時は空枠を詰める
            for _ in range(end_idx - start_idx):
                all_pages_spans.append([])
            continue

        for page in document.pages:
            page_spans = []
            # tokenではなく、lineベースで抽出する
            for i, line in enumerate(page.lines):
                text = ""
                for segment in line.layout.text_anchor.text_segments:
                    try:
                        start = int(
                            segment.start_index) if segment.start_index else 0
                    except (AttributeError, ValueError, TypeError):
                        start = 0
                    try:
                        end = int(
                            segment.end_index) if segment.end_index else 0
                    except (AttributeError, ValueError, TypeError):
                        end = 0
                    text += document.text[start:end]

                if not text.strip():
                    continue

                font_class = "gothic"
                # tokenからスタイル情報を見る
                if hasattr(line, "style_info") and line.style_info:
                    family = getattr(
                        line.style_info, "font_family", "").lower()
                    if "mincho" in family or "serif" in family:
                        font_class = "mincho"

                v = line.layout.bounding_poly.normalized_vertices
                if len(v) < 4:
                    continue

                x_min = min(v[0].x, v[1].x, v[2].x, v[3].x)
                y_min = min(v[0].y, v[1].y, v[2].y, v[3].y)
                x_max = max(v[0].x, v[1].x, v[2].x, v[3].x)
                y_max = max(v[0].y, v[1].y, v[2].y, v[3].y)

                page_spans.append({
                    "id": f"dai_{int(time.time() * 1000)}_{i}",
                    "text": text.strip(),
                    "font_class": font_class,
                    "size_pt": 9.0,
                    "x_pct": x_min * 100,
                    "y_pct": y_min * 100,
                    "w_pct": (x_max - x_min) * 100,
                    "h_pct": (y_max - y_min) * 100,
                })
            all_pages_spans.append(page_spans)

    doc.close()
    return all_pages_spans


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
    if file.content_type != "application/pdf":
        raise HTTPException(400, "PDFファイルのみ対応しています")

    try:
        pdf_bytes = await file.read()
        pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        pages_data = []

        # モード選択: Document AI をデフォルトで使用（明示的に "false" の場合のみ無効）
        use_docai = (x_use_documentai != "false")

        docai_results = []
        if use_docai:
            prj = x_project_id or "270124753853"
            loc = x_location or "asia-southeast1"
            proc = x_processor_id or "120a21840002e525"
            ver = x_version_id
            print(f"Using Document AI ({prj}, {loc}, {proc}, {ver})...")
            try:
                docai_results = _extract_spans_documentai(
                    pdf_bytes, prj, loc, proc, ver)
                print(f"Document AI extracted {len(docai_results)} pages")
            except Exception as docai_err:
                print(f"Document AI failed, falling back to Gemini: {docai_err}")
                docai_results = []

        for i in range(len(pdf_doc)):
            page = pdf_doc.load_page(i)
            rect = page.rect
            width_mm = rect.width * 0.352778
            height_mm = rect.height * 0.352778

            # 高解像度 PNG に変換
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            png_bytes = pix.tobytes("png")
            original_png_b64 = base64.b64encode(png_bytes).decode("utf-8")

            if use_docai and i < len(docai_results):
                spans = docai_results[i]
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

            pages_data.append({
                "page_index": i,
                "page_pt": [rect.width, rect.height],
                "page_mm": [width_mm, height_mm],
                "spans": spans,
                "raw_id_map": {},
                "images": [],
                "drawings": [],
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


# ── /rebuild エンドポイント ────────────────────────────────────────────────────

@app.post("/rebuild")
async def rebuild_pdf(req: dict[str, Any]):
    """PyMuPD でテキストを置換して修正PDF + プレビュー PNG を返す"""
    pdf_b64 = req.get("pdf_b64", "")
    edits = req.get("edits", {})
    original_texts = req.get("original_texts", {})
    overrides = req.get("overrides", {})
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
                # 部分一致を試行
                for word in old_text.split():
                    if len(word) >= 2:
                        rects = page.search_for(word)
                        if rects:
                            break

            if not rects:
                print(f"Text not found: '{old_text}'")
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

        print(f"Rebuild: {changes_applied}/{len(edits)}")

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
