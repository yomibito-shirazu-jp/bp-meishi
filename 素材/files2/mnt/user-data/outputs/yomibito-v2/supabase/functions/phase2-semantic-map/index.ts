// supabase/functions/phase2-semantic-map/index.ts
// ==========================================================
// PHASE 2 — 一手目：意味地図生成（セマンティックマップ）
// 全文ベクトル化・構造分析・粒度測定
// 正規化済み原稿 → コンポーネント単位に分解 → ベクトル化
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] }, taskType: "RETRIEVAL_DOCUMENT" }),
    }
  );
  const data = await resp.json();
  return data?.embedding?.values || [];
}

// 構造分析スキーマ（PGが固定）
const STRUCTURE_ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          chunk_id: { type: "STRING", description: "一意なチャンクID（例: section_01, qa_box_01）" },
          role: { type: "STRING", description: "コンポーネント種別: title, subtitle, body, qa_box, recipe, caption, header, footer, sidebar" },
          text: { type: "STRING", description: "該当テキスト" },
          heading_level: { type: "INTEGER", description: "見出しレベル（0=本文, 1=h1, 2=h2...）" },
        },
        required: ["chunk_id", "role", "text"],
      },
    },
    granularity: {
      type: "OBJECT",
      properties: {
        total_chars: { type: "INTEGER" },
        total_sections: { type: "INTEGER" },
        avg_section_length: { type: "NUMBER" },
        heading_depth: { type: "INTEGER", description: "最大見出し深度" },
      },
    },
  },
  required: ["sections", "granularity"],
};

serve(async (req: Request) => {
  try {
    const { project_id } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // A. 正規化済み原稿を取得（PHASE 1で最新のmerged_textがある場合はそれを使う）
    const { data: manuscripts } = await supabase
      .from("manuscripts")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at");

    const fullText = manuscripts?.map((m: any) => m.raw_text || "").join("\n\n") || "";

    if (!fullText.trim()) {
      return new Response(JSON.stringify({ error: "No text content found" }), { status: 404 });
    }

    // B. Geminiで構造分析（全文をセマンティックに分解）
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: STRUCTURE_ANALYSIS_SCHEMA,
            temperature: 0.0,
          },
          contents: [{
            parts: [{
              text: `あなたはDTP自動組版の構造分析エージェントです。
以下の原稿を「意味地図（セマンティックマップ）」に分解してください。

タスク:
1. テキストを意味のある最小単位（コンポーネント）に分解
2. 各チャンクにrole（title, body, qa_box, recipe, caption等）を割り当て
3. 粒度メトリクス（文字数、セクション数、平均長、見出し深度）を計算

【原稿】
${fullText}`,
            }],
          }],
        }),
      }
    );

    const geminiData = await resp.json();
    const analysisText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    const analysis = JSON.parse(analysisText || "{}");

    // C. セマンティックマップをDB保存
    const { data: semanticMap } = await supabase.from("semantic_maps").insert({
      project_id,
      structure_analysis: analysis,
      granularity_metrics: analysis.granularity || {},
      total_chars: analysis.granularity?.total_chars || fullText.length,
      total_sections: analysis.sections?.length || 0,
    }).select("id").single();

    // D. 各チャンクをベクトル化してDB保存（並列バッチ処理）
    const sections = analysis.sections || [];
    const BATCH_SIZE = 5;
    let insertedCount = 0;

    for (let i = 0; i < sections.length; i += BATCH_SIZE) {
      const batch = sections.slice(i, i + BATCH_SIZE);
      const embeddings = await Promise.all(
        batch.map((s: any) => getEmbedding(`${s.role}: ${s.text.substring(0, 300)}`))
      );

      const rows = batch.map((s: any, idx: number) => ({
        project_id,
        semantic_map_id: semanticMap?.id,
        chunk_id: s.chunk_id,
        role: s.role,
        text_content: s.text,
        embedding: embeddings[idx],
        order_index: i + idx,
      }));

      await supabase.from("content_chunks").insert(rows);
      insertedCount += rows.length;
    }

    // E. フェーズ進行 → PHASE 3
    await supabase.from("projects").update({
      current_phase: "phase3",
      updated_at: new Date().toISOString(),
    }).eq("id", project_id);

    return new Response(
      JSON.stringify({
        success: true,
        phase: "PHASE 2 — 意味地図生成",
        semantic_map_id: semanticMap?.id,
        chunks_created: insertedCount,
        granularity: analysis.granularity,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
