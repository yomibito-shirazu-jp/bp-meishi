import asyncio
import base64
import os
from backend.main import extract_corrections, ExtractCorrectionsRequest

async def main():
    try:
        # Create a dummy PDF to test
        import fitz
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((50, 50), "Test PDF for extraction", fontsize=12)
        pdf_bytes = doc.write()
        doc.close()
        
        pdf_b64 = base64.b64encode(pdf_bytes).decode("utf-8")
        req = ExtractCorrectionsRequest(pdf_b64=pdf_b64)
        
        print("Testing extract_corrections directly...")
        # Since extract_corrections is an async function, we await it
        result = await extract_corrections(req)
        
        # print the result
        print("SUCCESS! Result:")
        print(f"Tasks extracted: {len(result.get('tasks', []))}")
        
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}")

if __name__ == "__main__":
    asyncio.run(main())
