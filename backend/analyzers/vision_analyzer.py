import base64
from io import BytesIO
from typing import Any, Optional

try:
    from PIL import Image as PILImage, ImageChops
except ImportError:
    PILImage = None
    ImageChops = None

from google.cloud import vision
from .field_type import FieldType

class CloudVisionAnalyzer:
    """Cloud Vision APIを用いた画像要素（顔写真、ロゴ、印鑑）の解析・マッピング コンポーネント"""
    def __init__(self):
        try:
            self.client = vision.ImageAnnotatorClient()
        except Exception as e:
            self.client = None
            print(f"CloudVisionAnalyzer init error (Credentials missing?): {e}")

    def analyze_page_image(self, png_bytes: bytes) -> dict[str, Any]:
        """ページ画像から顔写真、ロゴ、印鑑などを検出し、論理的なフィールド（Enum）にマッピングする"""
        if not PILImage or not self.client:
            return {"objects": []}

        images_data = []
        try:
            vis_image = vision.Image(content=png_bytes)
            features = [
                vision.Feature(type_=vision.Feature.Type.OBJECT_LOCALIZATION, max_results=10),
                vision.Feature(type_=vision.Feature.Type.LOGO_DETECTION, max_results=10),
            ]
            vis_request = vision.AnnotateImageRequest(image=vis_image, features=features)
            vis_response = self.client.annotate_image(request=vis_request)

            pil_img = PILImage.open(BytesIO(png_bytes))
            png_w, png_h = pil_img.size
            vis_img_idx = 0

            # --- 1. オブジェクトローカライズ (顔, 人物等) ---
            for obj in vis_response.localized_object_annotations:
                # 座標計算
                vs = obj.bounding_poly.normalized_vertices
                if len(vs) < 4:
                    continue
                xs = [v.x for v in vs]
                ys = [v.y for v in vs]
                x_pct = min(xs) * 100
                y_pct = min(ys) * 100
                w_pct = (max(xs) - min(xs)) * 100
                h_pct = (max(ys) - min(ys)) * 100

                crop_x0 = int(min(xs) * png_w)
                crop_y0 = int(min(ys) * png_h)
                crop_x1 = int(max(xs) * png_w)
                crop_y1 = int(max(ys) * png_h)

                crop_w = crop_x1 - crop_x0
                crop_h = crop_y1 - crop_y0
                if crop_w < 10 or crop_h < 10:
                    continue

                crop_img = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))

                # 背景カットロジック（透過）
                bg = PILImage.new("RGB", crop_img.size, (255, 255, 255))
                if crop_img.mode in ("RGBA", "LA"):
                    bg.paste(crop_img, mask=crop_img.split()[-1])
                else:
                    bg.paste(crop_img)
                diff = ImageChops.difference(crop_img.convert("RGB"), bg)
                bbox = diff.getbbox()
                if bbox:
                    crop_img = crop_img.crop(bbox)
                    crop_x0 += bbox[0]
                    crop_y0 += bbox[1]
                    crop_x1 = crop_x0 + (bbox[2] - bbox[0])
                    crop_y1 = crop_y0 + (bbox[3] - bbox[1])
                    if crop_img.mode != "RGBA":
                        crop_img = crop_img.convert("RGBA")
                    datas = crop_img.getdata()
                    new_data = []
                    for item in datas:
                        if item[0] > 240 and item[1] > 240 and item[2] > 240:
                            new_data.append((255, 255, 255, 0))
                        else:
                            new_data.append(item)
                    crop_img.putdata(new_data)

                # base64エンコード
                buf = BytesIO()
                crop_img.save(buf, format="PNG")
                img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

                # ── オブジェクト名に基づいて論理的にマッピング ──
                obj_name_lower = obj.name.lower()
                field_type = FieldType.OTHER.value
                label_text = f"{obj.name} ({obj.score:.0%})"
                
                if "face" in obj_name_lower or "person" in obj_name_lower:
                    field_type = FieldType.FACE_PHOTO.value
                    label_text = f"顔写真: {obj.name} ({obj.score:.0%})"
                elif "logo" in obj_name_lower:
                    field_type = FieldType.LOGO_SYMBOL.value
                    label_text = f"ロゴ: {obj.name} ({obj.score:.0%})"
                elif "stamp" in obj_name_lower:
                    field_type = FieldType.STAMP.value
                    label_text = f"印鑑: {obj.name} ({obj.score:.0%})"

                images_data.append({
                    "id": f"vis_obj_{vis_img_idx}",
                    "xref": -1,
                    "data_b64": img_b64,
                    "mime_type": "image/png",
                    "width": crop_x1 - crop_x0,
                    "height": crop_y1 - crop_y0,
                    "x_pct": round(x_pct, 2),
                    "y_pct": round(y_pct, 2),
                    "w_pct": round(w_pct, 2),
                    "h_pct": round(h_pct, 2),
                    "bbox": [x_pct, y_pct, w_pct, h_pct],
                    "field_type": field_type,
                    "label": label_text,
                })
                vis_img_idx += 1

            # --- 2. ロゴ検出 ---
            for logo in vis_response.logo_annotations:
                vs = logo.bounding_poly.normalized_vertices
                if len(vs) < 4:
                    continue
                xs = [v.x for v in vs]
                ys = [v.y for v in vs]
                x_pct = min(xs) * 100
                y_pct = min(ys) * 100
                w_pct = (max(xs) - min(xs)) * 100
                h_pct = (max(ys) - min(ys)) * 100

                # 既に抽出済みのオブジェクトと重複する場合はスキップ
                is_duplicate = False
                for e in images_data:
                    cx = x_pct + w_pct / 2
                    cy = y_pct + h_pct / 2
                    ecx = e["x_pct"] + e["w_pct"] / 2
                    ecy = e["y_pct"] + e["h_pct"] / 2
                    if abs(cx - ecx) < 5.0 and abs(cy - ecy) < 5.0:
                        is_duplicate = True
                        break
                if is_duplicate:
                    continue

                crop_x0 = int(min(xs) * png_w)
                crop_y0 = int(min(ys) * png_h)
                crop_x1 = int(max(xs) * png_w)
                crop_y1 = int(max(ys) * png_h)
                
                crop_w = crop_x1 - crop_x0
                crop_h = crop_y1 - crop_y0
                if crop_w < 10 or crop_h < 10:
                    continue

                crop_img = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                buf = BytesIO()
                crop_img.save(buf, format="PNG")
                img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

                field_type = FieldType.LOGO_SYMBOL.value
                label_text = f"ロゴ: {logo.description} ({logo.score:.0%})"

                images_data.append({
                    "id": f"vis_logo_{vis_img_idx}",
                    "xref": -1,
                    "data_b64": img_b64,
                    "mime_type": "image/png",
                    "width": crop_w,
                    "height": crop_h,
                    "x_pct": round(x_pct, 2),
                    "y_pct": round(y_pct, 2),
                    "w_pct": round(w_pct, 2),
                    "h_pct": round(h_pct, 2),
                    "bbox": [x_pct, y_pct, w_pct, h_pct],
                    "field_type": field_type,
                    "label": label_text,
                })
                vis_img_idx += 1

            return {"objects": images_data}

        except Exception as e:
            print(f"Cloud Vision API image parsing error: {e}")
            return {"objects": images_data}
