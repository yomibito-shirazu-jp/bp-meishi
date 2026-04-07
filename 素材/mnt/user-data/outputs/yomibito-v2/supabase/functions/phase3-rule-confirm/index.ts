// supabase/functions/phase3-rule-confirm/index.ts
// ==========================================================
// PHASE 3 — 二手目：ルール確定
// CSS生成・グリッド・フォント・行送り
// 意味地図 + 顧客別ルール → Vivliostyle用CSS自動生成
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// CSS生成スキーマ（PGが固定）
const CSS_GENERATION_SCHEMA = {
  type: "OBJECT",
  properties: {
    page_css: { type: "STRING", description: "@page ルール（サイズ、マージン、柱、ノンブル）" },
    base_css: { type: "STRING", description: "body/p/ruby等のベース文字スタイル" },
    component_styles: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          component_type: { type: "STRING" },
          css_class: { type: "STRING", description: "CSSクラス名（例: .qa-box）" },
          css_rules: { type: "STRING", description: "完全なCSSルール" },
        },
        required: ["component_type", "css_class", "css_rules"],
      },
    },
  },
  required: ["page_css", "base_css", "component_styles"],
};

serve(async (req: Request) => {
  try {
    const { project_id, client_id } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // A. 必要データ収集
    const [{ data: globals }, { data: components }, { data: chunks }, { data: presets }] = await Promise.all([
      supabase.from("document_globals").select("*").eq("project_id", project_id).single(),
      supabase.from("components").select("*").eq("project_id", project_id),
      supabase.from("content_chunks").select("chunk_id, role, char_count").eq("project_id", project_id),
      supabase.from("client_presets").select("*").eq("client_id", client_id).eq("preset_type", "style"),
    ]);

    // B. コンポーネント種別ごとの統計
    const roleStats: Record<string, { count: number; avgChars: number }> = {};
    for (const c of chunks || []) {
      if (!roleStats[c.role]) roleStats[c.role] = { count: 0, avgChars: 0 };
      roleStats[c.role].count++;
      roleStats[c.role].avgChars += c.char_count;
    }
    for (const role in roleStats) {
      roleStats[role].avgChars = Math.round(roleStats[role].avgChars / roleStats[role].count);
    }

    // C. GeminiでCSS自動生成
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: CSS_GENERATION_SCHEMA,
            temperature: 0.0,
          },
          contents: [{
            parts: [{
              text: `あなたはVivliostyle（CSS組版）のエキスパートです。
以下のドキュメント設定とコンポーネント構造から、印刷品質のCSSを生成してください。

【ドキュメント設定】
${JSON.stringify(globals || {})}

【コンポーネント定義】
${JSON.stringify(components || [])}

【コンテンツ統計（role別の文字数平均）】
${JSON.stringify(roleStats)}

【顧客プリセット（過去のスタイル実績）】
${JSON.stringify((presets || []).map((p: any) => p.preset_data))}

要件:
- @page にはサイズ、マージン（天地のど小口）、@top-center（柱）、@bottom-center（ノンブル）を含む
- 日本語組版（JLReq）準拠: writing-mode, text-align, line-break: strict, word-break: break-all
- 級数（Q）はmm換算（1Q=0.25mm）でfont-sizeに設定
- 各コンポーネントの文字数制約をmax-height/overflowで表現
- Vivliostyleが解釈できる標準CSSのみ使用すること`,
            }],
          }],
        }),
      }
    );

    const geminiData = await resp.json();
    const cssData = JSON.parse(geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");

    // D. 生成CSSをDBに保存
    const fullCSS = [
      "/* === @page === */",
      cssData.page_css || "",
      "\n/* === Base Typography === */",
      cssData.base_css || "",
      "\n/* === Components === */",
      ...(cssData.component_styles || []).map((cs: any) => `/* ${cs.component_type} */\n${cs.css_rules}`),
    ].join("\n\n");

    await supabase.from("document_globals").update({ generated_css: fullCSS }).eq("project_id", project_id);

    // 各コンポーネントにもCSS保存
    for (const cs of cssData.component_styles || []) {
      await supabase.from("components")
        .update({ generated_css: cs.css_rules })
        .eq("project_id", project_id)
        .eq("component_type", cs.component_type);
    }

    // E. フェーズ進行 → PHASE 4
    await supabase.from("projects").update({
      current_phase: "phase4",
      updated_at: new Date().toISOString(),
    }).eq("id", project_id);

    return new Response(
      JSON.stringify({
        success: true,
        phase: "PHASE 3 — ルール確定",
        generated_css_length: fullCSS.length,
        component_styles_count: cssData.component_styles?.length || 0,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
