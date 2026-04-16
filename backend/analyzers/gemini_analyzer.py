import io
import base64
import json
from typing import Any, Optional
from PIL import Image as PILImage
import google.generativeai as genai
from .field_type import FieldType

# Enumを使用したスキーマ設定
GEMINI_SPAN_SCHEMA = {
  "type": "ARRAY",
  "items": {
    "type": "OBJECT",
    "properties": {
      "text": {"type": "STRING", "description": "テキスト内容"},
      "field_type": {"type": "STRING", "description": "フィールドの種類", "enum": [e.value for e in FieldType]},
      "font_class": {"type": "STRING", "description": "フォント分類: gothic, mincho, gothic_bold, light"},
      "size_pt": {"type": "NUMBER", "description": "推定フォントサイズ(pt)"},
      "x_pct": {"type": "NUMBER", "description": "左端X座標(0-100%)"},
      "y_pct": {"type": "NUMBER", "description": "上端Y座標(0-100%)"},
      "w_pct": {"type": "NUMBER", "description": "幅(0-100%)"},
      "h_pct": {"type": "NUMBER", "description": "高さ(0-100%)"},
      "writing_direction": {"type": "STRING", "description": "組方向: horizontal または vertical"},
    },
    "required": ["text", "field_type", "font_class", "size_pt", "x_pct", "y_pct", "w_pct", "h_pct"],
  },
}

GEMINI_EXTRACT_PROMPT = """
あなたは印刷・DTP、および名刺情報のデータ化・解析のスペシャリストです。
この画像（主に名刺）から、印刷または手書きされている**すべてのテキスト（文字）要素**および**ロゴ（シンボルマーク）内に含まれるテキスト**を、高精度かつ一切の漏れなく抽出し、以下のフィールドの種類に論理的にマッピングしてください。

【抽出対象のフィールド】
- **company_name**: 会社名
- **person_name**: 氏名
- **department**: 部署
- **position**: 役職
- **address**: 住所
- **postal_code**: 郵便番号（〒符号）
- **tel**: 電話番号（TEL, Tなどの記号を含む。手書き修正も含む）
- **fax**: FAX番号（FAX, Fなどの記号を含む。手書き修正も含む）
- **email**: メールアドレス（ロゴ内文字、手書き修正も含む）
- **url**: URL
- **catch_copy**: キャッチコピー
- **other**: 上記以外のすべてのテキスト（注記、ページ番号、小さな文字など）

【抽出ルール】
1. **画像上に表示されているすべてのテキスト（文字）を論理的なフィールドとして一切の漏れなく抽出すること。**
   ※ 小さな文字（フォントサイズ6pt以下）、住所、郵便番号、各種連絡先、キャッチコピー、そして**ロゴマーク内にデザインとして組み込まれている文字（例：会社名の英字ロゴなど）**、さらには**名刺に手書きで書き込まれた修正指示のテキスト（例：新しい電話番号）**も、必ず適切なフィールドとして抽出してください。
2. テキスト要素の位置を画像全体を100x100として正規化した座標で正確に返すこと。
3. 同一フィールド（例えば住所）が複数行に分かれている場合、それらを1つのフィールド値として統合してください。
4. 縦書きテキストも正確に検出し、writing_direction を "vertical" にすること。
5. 日本語・英語・数字・記号をすべて正確に読み取ること
6. 写真やロゴマークのシンボル部分の上に重ねられたテキストは抽出してください。

【重要】
- **ロゴ内の文字、手書き修正のテキスト、小さな文字（6pt以下）の検出漏れは、情報の欠落につながるため、一切許可されません。**
- 空文字のテキストは含めない
"""

class GeminiAnalyzer:
    """Gemini 2.0 Flash を用いたインテリジェントOCR・フィールドマッピング コンポーネント"""
    def __init__(self, api_key: str):
        self.api_key = api_key
        if api_key:
            genai.configure(api_key=api_key)
            self.model = genai.GenerativeModel("gemini-2.0-flash")
        else:
            self.model = None

    def _resize_image(self, png_bytes: bytes, max_dimension: int = 2048) -> bytes:
        img = PILImage.open(io.BytesIO(png_bytes))
        w, h = img.size
        if w > max_dimension or h > max_dimension:
            ratio = max_dimension / max(w, h)
            new_w = int(w * ratio)
            new_h = int(h * ratio)
            img = img.resize((new_w, new_h), PILImage.Resampling.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="PNG")
            return out.getvalue()
        return png_bytes

    async def analyze_business_card(
        self,
        png_bytes: bytes,
        page_w_pt: float,
        page_h_pt: float,
        layout_context: str = ""
    ) -> list[dict[str, Any]]:
        """Gemini 2.0 Flash で PNG → Field リストを抽出（構造化出力・マッピング済み）"""
        if not self.model:
            print("Error: Gemini API key is not set.")
            return []

        resized_bytes = self._resize_image(png_bytes)
        full_prompt = GEMINI_EXTRACT_PROMPT
        if layout_context:
            full_prompt += "\n\n--- Document AI Layout Analysis (for context) ---\n" + layout_context
            full_prompt += "\nUse this context to accurately map the fields. Some hand-written texts or logo texts might be missing in this context. Find them from the image."

        try:
            img_part = {
                "mime_type": "image/png",
                "data": base64.b64encode(resized_bytes).decode(),
            }
            response = await self.model.generate_content_async(
                [full_prompt, img_part],
                generation_config=genai.GenerationConfig(
                    temperature=0.1,
                    max_output_tokens=16384,
                    response_mime_type="application/json",
                    response_schema=GEMINI_SPAN_SCHEMA,
                ),
            )
            raw = response.text.strip()
        except Exception as e:
            print(f"Gemini API Error: {e}")
            return []

        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(line for line in lines if not line.startswith("```"))

        try:
            items = json.loads(raw)
        except json.JSONDecodeError:
            print(f"Gemini JSON parse error. raw={raw[:300]}")
            return []

        if not isinstance(items, list):
            return []

        spans = []
        for item in items:
            if not isinstance(item, dict) or not item.get("text", "").strip():
                continue
            try:
                x_pct = max(0, min(99, float(item.get("x_pct", 0))))
                y_pct = max(0, min(99, float(item.get("y_pct", 0))))
                w_pct = min(100 - x_pct, max(0.5, float(item.get("w_pct", 20))))
                h_pct = min(100 - y_pct, max(0.5, float(item.get("h_pct", 5))))
                size_pt = max(4.0, float(item.get("size_pt", 10)))
            except (ValueError, TypeError):
                continue

            bx = (x_pct / 100) * page_w_pt
            by = (y_pct / 100) * page_h_pt
            bw = (w_pct / 100) * page_w_pt
            bh = (h_pct / 100) * page_h_pt

            writing_dir = item.get("writing_direction", "horizontal")
            if writing_dir not in ("horizontal", "vertical"):
                writing_dir = "horizontal"

            field_type = item.get("field_type", FieldType.OTHER.value)

            spans.append({
                "id": f"s_gemini_{len(spans)}",
                "text": item["text"].strip(),
                "field_type": field_type,
                "font_original": "Gemini_Extracted",
                "font_class": item.get("font_class", "gothic"),
                "size_pt": round(size_pt, 1),
                "origin": [bx, by + bh],
                "bbox": [bx, by, bw, bh],
                "x_pct": round(x_pct, 2),
                "y_pct": round(y_pct, 2),
                "w_pct": round(w_pct, 2),
                "h_pct": round(h_pct, 2),
                "writing_direction": writing_dir,
                "source": "gemini",
            })

        print(f"Gemini extracted {len(spans)} fields mapped with FieldType enum")
        return spans
