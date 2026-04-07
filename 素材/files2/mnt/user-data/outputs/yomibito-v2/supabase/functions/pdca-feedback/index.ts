// supabase/functions/pdca-feedback/index.ts
// ==========================================================
// DATA LAYER — 学習基盤：PDCAフィードバック
// 運用するほど精度が上がる — 校正サイクルが構造的に不要になる
// PHASE 1 / PHASE 5 どちらの合議結果からもフィードバック可能
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
  return (await resp.json())?.embedding?.values || [];
}

async function summarizeAsRule(diff: any): Promise<string | null> {
  if (diff.action_type === "ACCEPTED") return null;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: { temperature: 0.0, maxOutputTokens: 150 },
        contents: [{
          parts: [{
            text: `DTP校正の差分から、50字以内の簡潔なルール文を1つだけ生成してください。ルール文のみ出力。
元: "${diff.original}"
AI提案: "${diff.ai_suggestion || "なし"}"
最終: "${diff.user_final}"
操作: ${diff.action_type === "MANUAL_OVERRIDE" ? "AI提案を覆して手動修正" : "エラーを無視"}`,
          }],
        }],
      }),
    }
  );
  return (await resp.json())?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

serve(async (req: Request) => {
  try {
    const { project_id, client_id, phase, feedbacks } = await req.json();
    // phase: "phase1" or "phase5"
    // feedbacks: Array<{ chunk_id, original, ai_suggestion, user_final, action_type }>

    if (!feedbacks?.length) {
      return new Response(JSON.stringify({ error: "feedbacks[] required" }), { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const results: any[] = [];

    for (const fb of feedbacks) {
      const logEntry: any = {
        project_id, client_id,
        phase: phase || "phase1",
        chunk_id: fb.chunk_id,
        original_text: fb.original,
        ai_suggestion: fb.ai_suggestion,
        user_final: fb.user_final,
        action_type: fb.action_type,
      };

      // MANUAL_OVERRIDE / REJECTED → 新ルール自動生成
      if (fb.action_type !== "ACCEPTED") {
        const newRule = await summarizeAsRule(fb);
        if (newRule) {
          const embedding = await getEmbedding(newRule);
          const { data: inserted } = await supabase.from("client_rules").insert({
            client_id,
            rule_text: newRule,
            rule_category: "notation",
            source: "pdca_auto",
            embedding,
          }).select("id").single();

          logEntry.generated_rule_text = newRule;
          logEntry.generated_rule_id = inserted?.id;
          results.push({ chunk_id: fb.chunk_id, new_rule: newRule, rule_id: inserted?.id });
        }
      } else {
        results.push({ chunk_id: fb.chunk_id, action: "ACCEPTED", new_rule: null });
      }

      await supabase.from("pdca_feedback_log").insert(logEntry);

      // 原稿チャンクも最終テキストに更新
      if (fb.user_final) {
        await supabase.from("content_chunks")
          .update({ text_content: fb.user_final })
          .eq("project_id", project_id)
          .eq("chunk_id", fb.chunk_id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        layer: "DATA LAYER — 学習基盤",
        processed: results.length,
        new_rules_generated: results.filter((r) => r.new_rule).length,
        note: "運用するほど精度が上がる",
        details: results,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
