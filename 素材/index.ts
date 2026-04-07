// supabase/functions/layout-detect/index.ts
// ==========================================================
// 「読み人知らず」構造抽出API（モードA: Step 1）
// PDF/画像 → Gemini 1.5 Pro → JSONプリセット → DB格納
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ==========================================
// PGが固定する「構造（事実）」のスキーマ
// AIはここに値を埋めるだけ（間違えにくい）
// ==========================================
const PAGE_PRESET_SCHEMA = {
  type: "OBJECT",
  properties: {
    page_geometry: {
      type: "OBJECT",
      description: "ページ全体のマージンと基本グリッド設定（単位mm/Q）",
      properties: {
        margins: {
          type: "OBJECT",
          properties: {
            top: { type: "NUMBER" },
            bottom: { type: "NUMBER" },
            inside: { type: "NUMBER" },
            outside: { type: "NUMBER" },
          },
        },
        base_column_count: { type: "INTEGER", description: "基本の段数" },
        base_font_size_q: { type: "NUMBER", description: "本文の級数（Q）" },
        base_line_height_q: { type: "NUMBER", description: "行送り（Q）" },
      },
    },
    components: {
      type: "ARRAY",
      description: "ページ内で検出された意味的コンポーネント",
      items: {
        type: "OBJECT",
        properties: {
          component_type: {
            type: "STRING",
            description: "例: main_article, qa_box, recipe_card, pull_quote, caption, header, footer",
          },
          component_name: {
            type: "STRING",
            description: "人間が判別できる日本語名",
          },
          writing_mode: {
            type: "STRING",
            description: "'vertical-rl' または 'horizontal-tb'",
          },
          font_size_q: {
            type: "NUMBER",
            description: "本文の級数（Q）。数値のみ。",
          },
          max_chars: {
            type: "INTEGER",
            description: "このコンポーネントに収まる最大文字数（推定）",
          },
          has_border: { type: "BOOLEAN", description: "枠線があるか" },
          border_color: { type: "STRING", description: "枠線のカラーコード（HEX）。なければ空文字" },
          has_background: { type: "BOOLEAN", description: "背景色があるか" },
          background_color: { type: "STRING", description: "背景色のカラーコード。なければ空文字" },
        },
        required: ["component_type", "component_name", "writing_mode", "font_size_q"],
      },
    },
  },
  required: ["page_geometry", "components"],
};

serve(async (req: Request) => {
  try {
    const { project_id, gcs_uri, mime_type, page_number } = await req.json();

    if (!project_id || !gcs_uri) {
      return new Response(JSON.stringify({ error: "project_id and gcs_uri are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ------------------------------------------
    // 1. Gemini 1.5 Pro でレイアウト構造を抽出
    // ------------------------------------------
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: PAGE_PRESET_SCHEMA,
            temperature: 0.0, // 創造性ゼロ。事実の抽出のみ。
          },
          contents: [
            {
              parts: [
                {
                  text: `あなたはプロのDTPオペレーターであり、自動組版システムの解析エンジンです。
提供されたページ画像を解析し、レイアウトの「プリセット」として再利用できるよう、
指定されたJSONスキーマに従ってパラメータ値のみを正確に抽出してください。
デザインの意図やHTMLタグは出力せず、純粋な数値とプロパティのみを返してください。
ページ番号: ${page_number || "不明"}`,
                },
                {
                  fileData: {
                    fileUri: gcs_uri,
                    mimeType: mime_type || "application/pdf",
                  },
                },
              ],
            },
          ],
        }),
      }
    );

    const geminiData = await geminiResponse.json();
    const extractedText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!extractedText) {
      return new Response(JSON.stringify({ error: "Gemini returned empty response", raw: geminiData }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const preset = JSON.parse(extractedText);

    // ------------------------------------------
    // 2. Supabaseに抽出結果を格納
    // ------------------------------------------
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // document_globals を upsert
    const { error: globalsError } = await supabase.from("document_globals").upsert({
      project_id,
      trim_size: preset.page_geometry?.margins || {},
      base_grid: {
        font_size: `${preset.page_geometry?.base_font_size_q || 13}Q`,
        line_height: `${preset.page_geometry?.base_line_height_q || 21}Q`,
        columns: preset.page_geometry?.base_column_count || 1,
      },
    }, { onConflict: "project_id" });

    // components を bulk insert
    const componentRows = (preset.components || []).map((c: any, i: number) => ({
      project_id,
      component_type: c.component_type,
      component_name: c.component_name || c.component_type,
      writing_mode: c.writing_mode || "vertical-rl",
      style_payload: {
        font_size_q: c.font_size_q,
        has_border: c.has_border,
        border_color: c.border_color,
        has_background: c.has_background,
        background_color: c.background_color,
      },
      max_chars: c.max_chars || null,
    }));

    const { error: compError } = await supabase.from("components").insert(componentRows);

    // page_layouts を insert
    const { error: layoutError } = await supabase.from("page_layouts").insert({
      project_id,
      layout_name: `Page ${page_number || "auto"}`,
      page_geometry: preset.page_geometry,
      source_file: gcs_uri,
      allowed_components: (preset.components || []).map((c: any) => c.component_type),
    });

    return new Response(
      JSON.stringify({
        success: true,
        preset,
        db_status: {
          globals: globalsError ? "error" : "ok",
          components: compError ? "error" : "ok",
          layouts: layoutError ? "error" : "ok",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
