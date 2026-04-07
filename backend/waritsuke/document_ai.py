from google.cloud import documentai_v1 as documentai

def run_document_ai(pdf_path: str, project_id: str,
                    location: str, processor_id: str) -> list[dict]:
    client = documentai.DocumentProcessorServiceClient()
    with open(pdf_path, "rb") as f:
        raw_document = documentai.RawDocument(
            content=f.read(), mime_type="application/pdf"
        )
    name = client.processor_path(project_id, location, processor_id)
    request = documentai.ProcessRequest(
        name=name, raw_document=raw_document
    )
    result = client.process_document(request=request)
    return extract_blocks(result.document)

def extract_blocks(document) -> list[dict]:
    """Document AIの出力からblock単位のbboxリストを返す"""
    blocks = []
    for page in document.pages:
        w = page.dimension.width
        h = page.dimension.height
        for block in page.blocks:
            v = block.layout.bounding_poly.normalized_vertices
            if not v or len(v) < 2:
                continue
            x0 = min(point.x for point in v)
            y0 = min(point.y for point in v)
            x1 = max(point.x for point in v)
            y1 = max(point.y for point in v)

            blocks.append({
                "page": page.page_number,
                "x_mm":      x0 * w * 25.4 / 72,
                "y_mm":      y0 * h * 25.4 / 72,
                "width_mm":  (x1 - x0) * w * 25.4 / 72,
                "height_mm": (y1 - y0) * h * 25.4 / 72,
                "type":      block.layout.orientation.name if hasattr(block.layout, "orientation") else "UNKNOWN",
            })
    return blocks
