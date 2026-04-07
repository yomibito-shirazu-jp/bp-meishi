// supabase/functions/pdca-feedback/index.ts
// ==========================================================
// 「読み人知らず」PDCAフィードバックAPI
// ユーザーの修正差分 → Geminiが新ルール要約 → RAG(pgvector)自動更新
// 「運用するほど精度が上がる」学習ループの核心
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// embedding生成
async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }),
    }
  );
  const data = await resp.json();
  return data?.embedding?.values || [];
}

// Geminiにルールを要約させる
async function generateRuleSummary(diff: {
  original: string;
  ai_suggestion: string | null;
  user_final: string;
  action_type: string;
  chunk_role: string;
}): Promise<string | null> {
  // ACCEPTED（AIの提案をそのまま受け入れ）の場合、新ルール不要
  if (diff.action_type === "ACCEPTED") return null;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 200,
        },
        contents: [
          {
            parts: [
              {
                text: `以下のDTP校正の差分から、今後のRAG検索で使える簡潔なルール文（1文、50字以内）を日本語で生成してください。
ルール文のみを出力し、それ以外は何も出力しないでください。

コンポーネント種別: ${diff.chunk_role}
元のテキスト: 「${diff.original}」
AIの提案: 「${diff.ai_suggestion || "なし"}」
ユーザーの最終決定: 「${diff.user_final}」
ユーザーのアクション: ${diff.action_type === "MANUAL_OVERRIDE" ? "AIの提案を覆して手動修正" : "AIが見逃した箇所を手動修正"}`,
              },
            ],
          },
        ],
      }),
    }
  );

  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

serve(async (req: Request) => {
  try {
    const { project_id, client_id, feedbacks } = await req.json();
    // feedbacks: Array<{ chunk_id, original, ai_suggestion, user_final, action_type, chunk_role }>

    if (!project_id || !client_id || !feedbacks?.length) {
      return new Response(
        JSON.stringify({ error: "project_id, client_id, and feedbacks[] required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const results: any[] = [];

    for (const fb of feedbacks) {
      // ------------------------------------------
      // 1. フィードバックログを記録
      // ------------------------------------------
      const logEntry: any = {
        project_id,
        client_id,
        chunk_id: fb.chunk_id,
        original_text: fb.original,
        ai_suggestion: fb.ai_suggestion,
        user_final: fb.user_final,
        action_type: fb.action_type,
      };

      // ------------------------------------------
      // 2. MANUAL_OVERRIDE / REJECTED → 新ルール生成
      // ------------------------------------------
      if (fb.action_type !== "ACCEPTED") {
        const newRuleText = await generateRuleSummary(fb);

        if (newRuleText) {
          // ルールのembeddingを生成
          const embedding = await getEmbedding(newRuleText);

          // 新ルールをclient_rulesに挿入
          const { data: insertedRule, error: ruleErr } = await supabase
            .from("client_rules")
            .insert({
              client_id,
              rule_text: newRuleText,
              rule_category: "notation", // デフォルト。将来的にGeminiに分類させても良い
              source: "pdca_auto",
              embedding,
            })
            .select("id")
            .single();

          logEntry.generated_rule_text = newRuleText;
          logEntry.generated_rule_id = insertedRule?.id || null;

          results.push({
            chunk_id: fb.chunk_id,
            action_type: fb.action_type,
            new_rule: newRuleText,
            rule_id: insertedRule?.id,
            error: ruleErr ? String(ruleErr) : null,
          });
        } else {
          results.push({
            chunk_id: fb.chunk_id,
            action_type: fb.action_type,
            new_rule: null,
            note: "ルール生成不要またはスキップ",
          });
        }
      } else {
        results.push({
          chunk_id: fb.chunk_id,
          action_type: "ACCEPTED",
          new_rule: null,
          note: "AI提案受け入れ。新ルール不要。",
        });
      }

      // ------------------------------------------
      // 3. ログをDBに記録
      // ------------------------------------------
      await supabase.from("pdca_feedback_log").insert(logEntry);

      // ------------------------------------------
      // 4. 原稿チャンクのテキストを最終版に更新
      // ------------------------------------------
      await supabase
        .from("content_chunks")
        .update({ text_content: fb.user_final })
        .eq("project_id", project_id)
        .eq("chunk_id", fb.chunk_id);
    }

    // ------------------------------------------
    // 5. プロジェクトステータスを更新
    // ------------------------------------------
    await supabase
      .from("projects")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", project_id);

    return new Response(
      JSON.stringify({
        success: true,
        processed: results.length,
        new_rules_generated: results.filter((r) => r.new_rule).length,
        details: results,
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
