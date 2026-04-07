import fitz  # PyMuPDF
import statistics

def extract_physical_data(pdf_path: str, blocks: list[dict]) -> list[dict]:
    doc = fitz.open(pdf_path)
    results = []
    for block in blocks:
        page_num = block.get("page", 1) - 1
        if page_num < 0 or page_num >= len(doc):
            continue
        page = doc[page_num]
        
        # Document AIのmm座標をPyMuPDFのpt座標に変換
        x_pt = block.get("x_mm", 0) * 72 / 25.4
        y_pt = block.get("y_mm", 0) * 72 / 25.4
        w_pt = block.get("width_mm", 0) * 72 / 25.4
        h_pt = block.get("height_mm", 0) * 72 / 25.4
        
        rect = fitz.Rect(x_pt, y_pt, x_pt + w_pt, y_pt + h_pt)
        rawdict = page.get_text("rawdict", clip=rect)
        measurements = measure_block(rawdict, block)
        results.append(measurements)
    doc.close()
    return results

def measure_block(rawdict: dict, block_meta: dict) -> dict:
    """rawdictから物理数値を数学的に算出する。推論は一切しない。"""
    spans, baselines, fonts = [], [], []
    text_buffer = []
 
    for block in rawdict.get("blocks", []):
        for line in block.get("lines", []):
            # ベースラインY座標を収集（行送り算出用）
            bbox = line.get("bbox", [0, 0, 0, 0])
            baselines.append(bbox[1])
            for span in line.get("spans", []):
                spans.append(span)
                fonts.append({
                    "name":    span.get("font", "unknown"),
                    "size_pt": span.get("size", 10.0),
                    "flags":   span.get("flags", 0),  # bold/italic判定
                })
                # サンプルテキスト抽出
                if "chars" in span:
                    text_buffer.append("".join(c["c"] for c in span["chars"] if "c" in c))
 
    if not spans:
        return {**block_meta, "error": "no_text_found", "text_sample": ""}
 
    # フォントサイズ：最頻値のptをQ数に変換
    sizes = [s["size_pt"] for s in spans]
    dominant_pt = statistics.mode(sizes) if sizes else 10.0
    font_size_Q = round(dominant_pt * 3.5278 / 0.25)  # pt→Q
 
    # 行送り：ベースライン差分の平均（2行以上の場合のみ）
    if len(baselines) >= 2:
        diffs = [abs(baselines[i+1]-baselines[i]) for i in range(len(baselines)-1)]
        line_spacing_H = round(statistics.mean(diffs) * 3.5278 / 0.25)
    else:
        line_spacing_H = None  # 測定不能 → null
 
    # 書字方向：Y方向にspanが並んでいれば縦組み
    writing_mode = detect_writing_mode(spans)
 
    # フォント名（最頻値）
    font_names = [f["name"] for f in fonts]
    dominant_font = statistics.mode(font_names) if font_names else "unknown"
 
    # 長体・平体の検出
    scale_x = detect_scale_x(spans)
 
    return {
        **block_meta,
        "font_family":    dominant_font,
        "font_size_Q":    font_size_Q,
        "line_spacing_H": line_spacing_H,
        "writing_mode":   writing_mode,
        "scale_x":        scale_x,
        "scale_y":        1.0,
        "_source_pt":     dominant_pt,       # 検算用生データ
        "_baselines":     baselines,         # 検算用生データ
        "text_sample":    "".join(text_buffer)[:100] # サンプルテキスト(100文字)
    }

def detect_writing_mode(spans: list) -> str:
    """X方向の分散 vs Y方向の分散で縦横を判定する"""
    if len(spans) < 2:
        return "horizontal-tb"  # デフォルトは横組み
    xs = [s["bbox"][0] for s in spans if "bbox" in s]
    ys = [s["bbox"][1] for s in spans if "bbox" in s]
    var_x = statistics.variance(xs) if len(xs) > 1 else 0
    var_y = statistics.variance(ys) if len(ys) > 1 else 0
    return "vertical-rl" if var_y > var_x else "horizontal-tb"

def detect_scale_x(spans: list) -> float | None:
    """bboxの幅 vs フォントサイズから長体率を算出する"""
    ratios = []
    for span in spans:
        if not span.get("chars"):
            continue
        for char in span["chars"]:
            if "bbox" not in char:
                continue
            char_w = char["bbox"][2] - char["bbox"][0]
            expected_w = span.get("size", 0)  # 正方形なら幅=高さ
            if expected_w > 0:
                ratios.append(char_w / expected_w)
    if not ratios:
        return None  # 測定不能
    ratio = round(statistics.median(ratios), 2)
    # 0.95〜1.05はベタ組み（丸め）
    return 1.0 if 0.95 <= ratio <= 1.05 else ratio

def check_fallback_level(page: fitz.Page) -> str:
    text = page.get_text()
    draws = page.get_drawings()
    images = page.get_images()
 
    if "(cid:" in text:
        return "L1"
    if not text.strip() and draws:
        return "L2"
    if not text.strip() and images:
        return "L3"
    return "OK"
