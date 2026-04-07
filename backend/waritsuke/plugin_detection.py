import re

def detect_plugins(measurements: list[dict],
                   doc_meta: dict) -> dict[str, bool]:
    """
    全ページの測定結果を受け取り、
    どのプラグインが必要かをboolで返す。
    """
    return {
        "newspaper": detect_newspaper(measurements, doc_meta),
        "pamphlet":  detect_pamphlet(measurements, doc_meta),
        "academic":  detect_academic(measurements, doc_meta),
    }

def detect_newspaper(measurements: list[dict], doc_meta: dict) -> bool:
    score = 0
    page_width = doc_meta.get("width_mm", 210.0)
 
    for m in measurements:
        col_count = m.get("column_settings", {}).get("column_count", 1)
        if col_count >= 4:
            score += 2
            break
 
    writing_modes = {m.get("writing_mode") for m in measurements if m.get("writing_mode")}
    if len(writing_modes) >= 2:
        score += 2
 
    for m in measurements:
        bbox = m.get("bounding_box", {})
        width = bbox.get("width", 0)
        if m.get("role") == "Title_Main" and width >= page_width * 0.66:
            score += 1
            break
 
    return score >= 2

def detect_pamphlet(measurements: list[dict], doc_meta: dict) -> bool:
    score = 0
    total = doc_meta.get("total_pages", 0)
 
    if total % 2 == 0 and 2 <= total <= 16:
        score += 3
 
    page_structures = [
        frozenset(m.get("role") for m in measurements if m.get("page") == pg)
        for pg in range(1, total + 1)
    ]
    if len(set(page_structures)) <= 2 and total > 0:
        score += 2
 
    modes = {m.get("writing_mode") for m in measurements if m.get("writing_mode")}
    if modes == {"horizontal-tb"}:
        score += 1
 
    return score >= 3

def detect_academic(measurements: list[dict], doc_meta: dict) -> bool:
    score = 0
    page_height = doc_meta.get("height_mm", 297.0)
 
    for m in measurements:
        bbox = m.get("bounding_box", {})
        y = bbox.get("y", 0)
        q = m.get("font_size_Q", 999) or 999
        if y > page_height * 0.85 and q <= 8:
            score += 3
            break
 
    all_text = " ".join(str(m.get("text_sample", "")) for m in measurements)
    if re.search(r"図\d|Fig\.\d|表\d", all_text):
        score += 2
    if re.search(r"参考文献|References", all_text):
        score += 2
    if re.search(r"10\.\d{4}/", all_text):
        score += 1
 
    return score >= 3
