import fitz
import base64
import json
from io import BytesIO
import backend.main as backend

def create_sample_meishi() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=258, height=155) # Business card approx 91x55mm
    
    # 会社名
    page.insert_text((20, 30), "株式会社サンプル", fontsize=12, fontname="cjk")
    # 役職
    page.insert_text((20, 60), "代表取締役", fontsize=8, fontname="cjk")
    # 氏名
    page.insert_text((20, 80), "山田 太郎", fontsize=16, fontname="cjk")
    # 電話
    page.insert_text((20, 130), "TEL: 03-1234-5678", fontsize=8, fontname="cjk")
    
    return doc.write()

def run_test():
    old_pdf_bytes = create_sample_meishi()
    with open("sample_meishi.pdf", "wb") as f:
        f.write(old_pdf_bytes)
    print("Created sample_meishi.pdf")

    # 手動でスパンを定義（実際のフロントエンドからの入力を想定）
    # (x_pct, y_pct, w_pct, h_pct) は割合計算
    # page width=258, height=155
    spans = [
        {
            "id": "span_1",
            "text": "株式会社サンプル",
            "x_pct": (20/258)*100,
            "y_pct": (20/155)*100,  # approximate bounding box start
            "w_pct": int((100/258)*100),
            "h_pct": int((12/155)*100),
            "font_class": "gothic",
            "size_pt": 12,
            "writing_direction": "horizontal"
        },
        {
            "id": "span_2",
            "text": "山田 太郎",
            "x_pct": (20/258)*100,
            "y_pct": (65/155)*100,
            "w_pct": (80/258)*100,
            "h_pct": (16/155)*100,
            "font_class": "mincho",
            "size_pt": 16,
            "writing_direction": "horizontal"
        }
    ]

    # 山田 太郎 -> 鈴木 一郎 に変更
    edits = [
        {"id": "span_1", "new_text": "テスト合同会社", "expand": True},
        {"id": "span_2", "new_text": "鈴木 一郎", "expand": True}
    ]
    
    req = backend.RebuildRequest(
        pdf_b64=base64.b64encode(old_pdf_bytes).decode("utf-8"),
        edits=edits,
        original_spans=spans,
        page_index=0,
        dpi=300
    )
    
    import asyncio
    print("Calling rebuild_pdf...")
    res = asyncio.run(backend.rebuild_pdf(req))
    
    new_pdf_bytes = base64.b64decode(res["pdf_b64"])
    with open("sample_meishi_rebuilt.pdf", "wb") as f:
        f.write(new_pdf_bytes)
    
    print("Rebuild process complete. Generated sample_meishi_rebuilt.pdf")
    
    # Verify the output text
    doc2 = fitz.open("sample_meishi_rebuilt.pdf")
    text = doc2[0].get_text("text").strip()
    
    print("--- Extracted text from rebuilt PDF ---")
    print(text)
    print("---------------------------------------")
    
    if "鈴木 一郎" in text and "山田 太郎" not in text and "テスト合同会社" in text:
        print("TEST PASSED: Edits were successfully applied.")
    else:
        print("TEST FAILED: Text check failed.")

if __name__ == "__main__":
    run_test()
