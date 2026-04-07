// supabase/functions/rag-validate/index.ts
// ==========================================================
// 「読み人知らず」RAG検証API（モードB: Step 2-3）
// 原稿チャンク × 顧客ルール(pgvector) × レイアウト制約 → 合否判定
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ==========================================
// 検証結果のスキーマ（PGが固定 → AIは値のみ埋める）
// ==========================================
const VALIDATION_REPORT_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      chunk_id: { type: "STRING" },
      status: { type: "STRING", description: "'OK' or 'NG'" },
      errors: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            error_type: {
              type: "STRING",
              description: "'文字あふれ','表記ルール違反','禁則エラー','画質エラー','その他'",
            },
            original_text: { type: "STRING" },
            suggested_action: { type: "STRING" },
            reason_ref: { type: "STRING" },
          },
          required: ["error_type", "suggested_action", "reason_ref"],
        },
      },
    },
    required: ["chunk_id", "status"],
  },
};

// ==========================================
// テキストからembeddingを生成（Gemini Embedding API）
// ==========================================
async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
      }),
    }
  );
  const data = await resp.json();
  return data?.embedding?.values || [];
}

serve(async (req: Request) => {
  try {
    const { project_id, client_id } = await req.json();

    if (!project_id || !client_id) {
      return new Response(JSON.stringify({ error: "project_id and client_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ------------------------------------------
    // A. DBから原稿チャンクとレイアウト制約を取得
    // ------------------------------------------
    const { data: chunks } = await supabase
      .from("content_chunks")
      .select("*, components(*)")
      .eq("project_id", project_id)
      .order("order_index");

    const { data: globals } = await supabase
      .from("document_globals")
      .select("*")
      .eq("project_id", project_id)
      .single();

    if (!chunks || chunks.length === 0) {
      return new Response(JSON.stringify({ error: "No content chunks found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ------------------------------------------
    // B. チャンクごとにRAGでルールを引き当て
    // ------------------------------------------
    const chunksWithRules = await Promise.all(
      chunks.map(async (chunk: any) => {
        // チャンクのテキストからembeddingを生成
        const queryText = `${chunk.role} ${chunk.text_content.substring(0, 200)}`;
        const embedding = await getEmbedding(queryText);

        // pgvectorでコサイン類似度検索
        const { data: matchedRules } = await supabase.rpc("match_client_rules", {
          p_client_id: client_id,
          p_query_embedding: embedding,
          p_match_threshold: 0.4,
          p_match_count: 5,
        });

        return {
          ...chunk,
          matched_rules: matchedRules || [],
          layout_constraint: chunk.components || null,
        };
      })
    );

    // ------------------------------------------
    // C. Gemini で一括検証（responseSchema で型を強制）
    // ------------------------------------------
    const promptChunks = chunksWithRules.map((c: any) => ({
      chunk_id: c.chunk_id,
      role: c.role,
      text: c.text_content,
      char_count: c.char_count,
      max_chars: c.layout_constraint?.max_chars || null,
      writing_mode: c.layout_constraint?.writing_mode || "vertical-rl",
      rules: c.matched_rules.map((r: any) => `[${r.rule_category}] ${r.rule_text}`),
    }));

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: VALIDATION_REPORT_SCHEMA,
            temperature: 0.0,
          },
          contents: [
            {
              parts: [
                {
                  text: `あなたはプロのDTP品質管理エージェントです。
提供された「原稿チャンク」が、「レイアウトの制約」および「顧客ルール」に完全に適合しているか検証してください。

【検証ルール】
1. max_chars が設定されている場合、char_count がそれを超えていたら「文字あふれ」エラー
2. 各チャンクに付与された rules を1つずつ照合し、違反があれば「表記ルール違反」エラー
3. 1つでも違反があれば status は 'NG'。違反がなければ 'OK'
4. エラーがある場合は必ず具体的な修正案（suggested_action）を提示すること

【グローバル設定】
${JSON.stringify(globals || {})}

【検証対象チャンク】
${JSON.stringify(promptChunks, null, 2)}`,
                },
              ],
            },
          ],
        }),
      }
    );

    const geminiData = await geminiResponse.json();
    const reportText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reportText) {
      return new Response(JSON.stringify({ error: "Gemini validation returned empty", raw: geminiData }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const validationReport = JSON.parse(reportText);

    // ------------------------------------------
    // D. 検証結果をDBに保存
    // ------------------------------------------
    const { error: saveError } = await supabase.from("validation_reports").insert({
      project_id,
      report_type: "rag",
      status: validationReport.every((v: any) => v.status === "OK")
        ? "READY_FOR_TYPESETTING"
        : "NEEDS_REVISION",
      summary: {
        total_chunks: validationReport.length,
        ok_count: validationReport.filter((v: any) => v.status === "OK").length,
        ng_count: validationReport.filter((v: any) => v.status === "NG").length,
      },
      component_details: validationReport,
    });

    return new Response(
      JSON.stringify({
        success: true,
        report: validationReport,
        summary: {
          total: validationReport.length,
          ok: validationReport.filter((v: any) => v.status === "OK").length,
          ng: validationReport.filter((v: any) => v.status === "NG").length,
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
