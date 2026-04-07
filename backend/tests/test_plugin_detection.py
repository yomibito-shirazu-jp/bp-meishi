from backend.extractor.plugin_detection import detect_newspaper, detect_pamphlet, detect_academic

def test_detect_newspaper_positive():
    """段組み4段以上＋縦横混在でTrueになること (2+2 = 4 >= 2)"""
    measurements = [
        {"column_settings": {"column_count": 4}, "writing_mode": "vertical-rl"},
        {"writing_mode": "horizontal-tb"},
    ]
    assert detect_newspaper(measurements, {"width_mm": 420}) == True
 
def test_detect_newspaper_negative():
    """2段・横組みのみでFalseになること (0+0+0 = 0 < 2)"""
    measurements = [
        {"column_settings": {"column_count": 2}, "writing_mode": "horizontal-tb"},
    ]
    assert detect_newspaper(measurements, {"width_mm": 210}) == False

def test_detect_pamphlet_positive():
    """偶数ページ(2-16)(3点), 同一構造2種以下(2点), 全て横書き(1点) → 6点でTrue"""
    measurements = [
        {"page": 1, "role": "Title", "writing_mode": "horizontal-tb"},
        {"page": 2, "role": "Title", "writing_mode": "horizontal-tb"},
        {"page": 3, "role": "Title", "writing_mode": "horizontal-tb"},
        {"page": 4, "role": "Title", "writing_mode": "horizontal-tb"},
    ]
    assert detect_pamphlet(measurements, {"total_pages": 4}) == True

def test_detect_academic():
    """脚注(3点) + 図のキャプション(2点) + 参考文献(2点) → 7点でTrue"""
    measurements = [
        {"font_size_Q": 7, "bounding_box": {"y": 280, "width": 100}, "text_sample": "脚注です"},
        {"font_size_Q": 10, "bounding_box": {"y": 100, "width": 100}, "text_sample": "図1に示されるように、"},
        {"font_size_Q": 10, "bounding_box": {"y": 200, "width": 100}, "text_sample": "参考文献"}
    ]
    # y=280 is > 297 * 0.85 (252.45), so footnote condition triggers.
    assert detect_academic(measurements, {"height_mm": 297}) == True
