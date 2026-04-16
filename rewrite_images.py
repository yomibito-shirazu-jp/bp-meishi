import re

with open("backend/main.py", "r", encoding="utf-8") as f:
    code = f.read()

# We need to replace the section from:
#             # ── 画像抽出 ──
# to:
#             # ── 描画要素(罫線・背景色)抽出 ──

start_marker = "            # ── 画像抽出 ──"
end_marker = "            # ── 描画要素(罫線・背景色)抽出 ──"

start_idx = code.find(start_marker)
end_idx = code.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print("Markers not found!")
    exit(1)

new_section = r"""            # ── 画像抽出 ──
            images_data = []

            def _is_image_duplicate(nx, ny, nw, nh, threshold=5.0):
                for e in images_data:
                    # 中心の距離とサイズの近さで判定
                    cx = nx + nw / 2
                    cy = ny + nh / 2
                    ecx = e["x_pct"] + e["w_pct"] / 2
                    ecy = e["y_pct"] + e["h_pct"] / 2
                    if abs(cx - ecx) < threshold and abs(cy - ecy) < threshold and abs(nw - e["w_pct"]) < threshold and abs(nh - e["h_pct"]) < threshold:
                        return True
                return False

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
                        
                        # ゴミ画像をフィルタ
                        if img_w < 50 or img_h < 50:
                            continue

                        # 画像のページ内位置を探す
                        img_rects = page.get_image_rects(xref)
                        if img_rects:
                            ir = img_rects[0]
                            x_pct = (ir.x0 / rect.width) * 100
                            y_pct = (ir.y0 / rect.height) * 100
                            w_pct = ((ir.x1 - ir.x0) / rect.width) * 100
                            h_pct = ((ir.y1 - ir.y0) / rect.height) * 100
                            
                            # ほぼページ全体の画像（背景レイヤー等）は除外
                            if w_pct > 95 and h_pct > 95:
                                continue
                        else:
                            x_pct, y_pct, w_pct, h_pct = 0, 0, 50, 50

                        if _is_image_duplicate(x_pct, y_pct, w_pct, h_pct):
                            continue

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
            if docai_layout_blocks and PILImage:
                try:
                    pil_img = PILImage.open(BytesIO(png_bytes))
                    png_w, png_h = pil_img.size
                    for lb_idx, lb in enumerate(docai_layout_blocks):
                        if lb.get("type") != "image":
                            continue
                        
                        lb_x = lb["x_pct"]
                        lb_y = lb["y_pct"]
                        lb_w = lb["w_pct"]
                        lb_h = lb["h_pct"]

                        # 既存と重複チェック
                        if _is_image_duplicate(lb_x, lb_y, lb_w, lb_h, threshold=8.0):
                            continue

                        # layout_blocks の座標は pct
                        crop_x0 = int(lb_x / 100 * png_w)
                        crop_y0 = int(lb_y / 100 * png_h)
                        crop_x1 = int((lb_x + lb_w) / 100 * png_w)
                        crop_y1 = int((lb_y + lb_h) / 100 * png_h)
                        if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
                            continue
                        
                        cropped = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                        
                        # 白背景の余白をなるべく削る (Document AIのCropがあまい対策)
                        if ImageChops:
                            try:
                                bg = PILImage.new("RGB", cropped.size, (255, 255, 255))
                                diff = ImageChops.difference(cropped.convert("RGB"), bg)
                                bbox = diff.getbbox()
                                if bbox:
                                    cropped = cropped.crop(bbox)
                                    # bbox は (left, upper, right, lower)
                                    crop_x0 += bbox[0]
                                    crop_y0 += bbox[1]
                                    crop_x1 = crop_x0 - bbox[0] + bbox[2]
                                    crop_y1 = crop_y0 - bbox[1] + bbox[3]
                                    # pct再計算
                                    lb_x = (crop_x0 / png_w) * 100
                                    lb_y = (crop_y0 / png_h) * 100
                                    lb_w = ((crop_x1 - crop_x0) / png_w) * 100
                                    lb_h = ((crop_y1 - crop_y0) / png_h) * 100
                            except:
                                pass

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
                            "x_pct": lb_x,
                            "y_pct": lb_y,
                            "w_pct": lb_w,
                            "h_pct": lb_h,
                            "bbox": [lb_x, lb_y, lb_w, lb_h],
                        })
                    if images_data:
                        print(f"Document AI / PyMuPDF detected {len(images_data)} image blocks")
                except Exception as docai_img_err:
                    print(f"DocAI image extraction fallback error: {docai_img_err}")

            # ── Vision API での画像検出（印鑑・ロゴ・スタンプ等） ──
            if PILImage:
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
                        
                        x_pct = x_min * 100
                        y_pct = y_min * 100
                        w_pct = (x_max - x_min) * 100
                        h_pct = (y_max - y_min) * 100

                        if _is_image_duplicate(x_pct, y_pct, w_pct, h_pct, threshold=8.0):
                            continue

                        crop_x0 = int(x_min * png_w)
                        crop_y0 = int(y_min * png_h)
                        crop_x1 = int(x_max * png_w)
                        crop_y1 = int(y_max * png_h)
                        if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
                            continue
                        
                        cropped = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                        # 白背景カット
                        if ImageChops:
                            try:
                                bg = PILImage.new("RGB", cropped.size, (255, 255, 255))
                                diff = ImageChops.difference(cropped.convert("RGB"), bg)
                                bbox = diff.getbbox()
                                if bbox:
                                    cropped = cropped.crop(bbox)
                                    crop_x0 += bbox[0]
                                    crop_y0 += bbox[1]
                                    crop_x1 = crop_x0 - bbox[0] + bbox[2]
                                    crop_y1 = crop_y0 - bbox[1] + bbox[3]
                                    x_pct = (crop_x0 / png_w) * 100
                                    y_pct = (crop_y0 / png_h) * 100
                                    w_pct = ((crop_x1 - crop_x0) / png_w) * 100
                                    h_pct = ((crop_y1 - crop_y0) / png_h) * 100
                            except:
                                pass
                                
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
                            "x_pct": x_pct,
                            "y_pct": y_pct,
                            "w_pct": w_pct,
                            "h_pct": h_pct,
                            "bbox": [x_pct, y_pct, w_pct, h_pct],
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

                        x_pct = x_min * 100
                        y_pct = y_min * 100
                        w_pct = (x_max - x_min) * 100
                        h_pct = (y_max - y_min) * 100

                        if _is_image_duplicate(x_pct, y_pct, w_pct, h_pct, threshold=5.0):
                            continue

                        crop_x0 = int(x_min * png_w)
                        crop_y0 = int(y_min * png_h)
                        crop_x1 = int(x_max * png_w)
                        crop_y1 = int(y_max * png_h)
                        if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
                            continue
                        
                        cropped = pil_img.crop((crop_x0, crop_y0, crop_x1, crop_y1))
                        # 白背景カット
                        if ImageChops:
                            try:
                                bg = PILImage.new("RGB", cropped.size, (255, 255, 255))
                                diff = ImageChops.difference(cropped.convert("RGB"), bg)
                                bbox = diff.getbbox()
                                if bbox:
                                    cropped = cropped.crop(bbox)
                                    crop_x0 += bbox[0]
                                    crop_y0 += bbox[1]
                                    crop_x1 = crop_x0 - bbox[0] + bbox[2]
                                    crop_y1 = crop_y0 - bbox[1] + bbox[3]
                                    x_pct = (crop_x0 / png_w) * 100
                                    y_pct = (crop_y0 / png_h) * 100
                                    w_pct = ((crop_x1 - crop_x0) / png_w) * 100
                                    h_pct = ((crop_y1 - crop_y0) / png_h) * 100
                            except:
                                pass

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
                            "x_pct": x_pct,
                            "y_pct": y_pct,
                            "w_pct": w_pct,
                            "h_pct": h_pct,
                            "bbox": [x_pct, y_pct, w_pct, h_pct],
                            "label": f"Logo: {logo.description} ({logo.score:.0%})",
                        })
                        vis_img_idx += 1

                    if images_data:
                        print(f"Vision API appended images, total is now {len(images_data)}")
                except Exception as vis_img_err:
                    print(f"Vision API image detection error: {vis_img_err}")

"""

code = code[:start_idx] + new_section + code[end_idx:]

with open("backend/main.py", "w", encoding="utf-8") as f:
    f.write(code)

print("Rewrite successful.")
