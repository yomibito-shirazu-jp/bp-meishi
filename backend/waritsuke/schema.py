import json
from pydantic import BaseModel
from typing import Optional, Any

def group_by_page(measurements: list[dict]) -> list[list[dict]]:
    pages = {}
    for m in measurements:
        p = m.get("page", 1)
        if p not in pages:
            pages[p] = []
        pages[p].append(m)
    # Sort pages by page number
    return [pages[k] for k in sorted(pages.keys())]

def build_page(page_measurements: list[dict], doc_meta: dict) -> dict:
    page_number = page_measurements[0].get("page", 1) if page_measurements else 1
    return {
        "page_number": page_number,
        "components": page_measurements
    }

def build_base_preset(measurements: list[dict], doc_meta: dict) -> dict:
    """測定結果をpreset.json v2.1.0スキーマに変換する"""
    return {
        "preset_id":      doc_meta.get("preset_id", "default_preset"),
        "schema_version": "2.1.0",
        "document_metadata": {
            "trim_size":          doc_meta.get("trim_size", "A4"),
            "width_mm":           doc_meta.get("width_mm", 210.0),
            "height_mm":          doc_meta.get("height_mm", 297.0),
            "binding_direction":  doc_meta.get("binding_direction", "right_to_left"),
            "coordinate_origin":  "top_left",
            "unit":               "mm",
            "color_space":        "CMYK",
        },
        "pages": [build_page(m, doc_meta) for m in group_by_page(measurements)]
    }

def build_newspaper_plugin(measurements: list[dict], doc_meta: dict) -> dict:
    return {
        "status": "active",
        "newspaper_settings": {
            "allow_multi_column_spanning": True,
            "allow_mixed_orientation": True,
            "column_rules_enabled": True,
            "max_columns": doc_meta.get("max_columns", 4)
        }
    }

def build_pamphlet_plugin(measurements: list[dict], doc_meta: dict) -> dict:
    return {
        "status": "active",
        "pamphlet_settings": {
            "folding_processing": "tri_fold_or_center_fold",
            "imposition_order": "booklet",
            "duplex_printing": True,
            "total_pages": doc_meta.get("total_pages", 8)
        }
    }

def build_academic_plugin(measurements: list[dict], doc_meta: dict) -> dict:
    return {
        "status": "active",
        "academic_settings": {
            "has_footnotes": True,
            "has_references": True,
            "has_figure_numbers": True,
            "has_doi": True,
            "footnote_max_font_size_Q": 8,
            "ruby_disabled_in_vertical": True
        }
    }

def build_plugin_presets(plugin_flags: dict[str, bool],
                        measurements: list[dict],
                        doc_meta: dict) -> dict[str, dict]:
    """検出されたプラグインのみJSONを生成して返す"""
    result = {}
    if plugin_flags.get("newspaper"):
        result["newspaper"] = build_newspaper_plugin(measurements, doc_meta)
    if plugin_flags.get("pamphlet"):
        result["pamphlet"]  = build_pamphlet_plugin(measurements, doc_meta)
    if plugin_flags.get("academic"):
        result["academic"]  = build_academic_plugin(measurements, doc_meta)
    return result

def write_ground_truth_log(measurements: list[dict], log_path: str) -> None:
    """1コンポーネント1行のJSONLで保存する"""
    with open(log_path, "w", encoding="utf-8") as f:
        for m in measurements:
            log_entry = {
                "component_id":  m.get("component_id", "unknown"),
                "font_size_Q":   m.get("font_size_Q"),
                "_source_pt":    m.get("_source_pt"),     # 検算用
                "line_spacing_H":m.get("line_spacing_H"),
                "_baselines":    m.get("_baselines"),     # 検算用
                "writing_mode":  m.get("writing_mode"),
                "scale_x":       m.get("scale_x"),
            }
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
