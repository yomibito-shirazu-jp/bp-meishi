// supabase/functions/phase1-normalize/index.ts
// ==========================================================
// PHASE 1 — 入口の合議：三者合議① — 原稿正規化
// Agent 1: 表記検証 / Agent 2: 構造照合 / Agent 3: 意味検証
// 表記揺れ除去・マージ・地雷除去
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
      body: JSON.stringify({ content: { parts: [{ text }] }, taskType: "RETRIEVAL_QUERY" }),
    }
  );
  const data = await resp.json();
  return data?.embedding?.values || [];
}

// Gemini呼び出しヘルパー
async function callGemini(prompt: string, schema?: any): Promise<string> {
  const config: any = { temperature: 0.0, maxOutputTokens: 4096 };
  if (schema) {
    config.responseMimeType = "application/json";
    config.responseSchema = schema;
  }
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: config,
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ==========================================
// 三者合議のJSONスキーマ（PGが固定）
// ==========================================
const AGENT_FINDINGS_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      finding_type: { type: "STRING", description: "'表記揺れ','誤字脱字','構造不整合','意味矛盾','地雷(危険表現)'" },
      location: { type: "STRING", description: "該当箇所（テキストの一部引用）" },
      description: { type: "STRING", description: "問題の説明" },
      suggested_fix: { type: "STRING", description: "修正案" },
      severity: { type: "STRING", description: "'critical','warning','info'" },
    },
    required: ["finding_type", "location", "description", "severity"],
  },
};

serve(async (req: Request) => {
  try {
    const { project_id, client_id } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // A. 全原稿を取得
    const { data: manuscripts } = await supabase
      .from("manuscripts")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at");

    if (!manuscripts?.length) {
      return new Response(JSON.stringify({ error: "No manuscripts found" }), { status: 404 });
    }

    const mergedText = manuscripts.map((m: any) => m.raw_text || "").join("\n\n---\n\n");

    // B. 顧客別ルールをRAGで引き当て
    const queryEmbed = await getEmbedding(mergedText.substring(0, 500));
    const { data: clientRules } = await supabase.rpc("match_client_rules", {
      p_client_id: client_id,
      p_query_embedding: queryEmbed,
      p_match_threshold: 0.3,
      p_match_count: 10,
    });
    const rulesContext = (clientRules || []).map((r: any) => `[${r.rule_category}] ${r.rule_text}`).join("\n");

    // ==========================================
    // C. 三者合議：3エージェントを並列実行
    // ==========================================
    const [agent1Result, agent2Result, agent3Result] = await Promise.all([
      // --- Agent 1: 表記検証 ---
      callGemini(
        `あなたはDTP表記検証エージェントです。以下の原稿を校正し、表記揺れ・誤字脱字・用語統一の問題を検出してください。
【顧客ルール】\n${rulesContext || "なし"}
【原稿】\n${mergedText}`,
        AGENT_FINDINGS_SCHEMA
      ),

      // --- Agent 2: 構造照合 ---
      callGemini(
        `あなたはDTP構造照合エージェントです。以下の原稿の構造的な問題を検出してください。
見出しの階層の不整合、章番号の欠落、参照の不一致などを確認してください。
【原稿】\n${mergedText}`,
        AGENT_FINDINGS_SCHEMA
      ),

      // --- Agent 3: 意味検証 ---
      callGemini(
        `あなたはDTP意味検証エージェントです。以下の原稿に含まれる論理的矛盾、事実誤認の可能性、
不適切表現（地雷）、文脈の断絶を検出してください。
【原稿】\n${mergedText}`,
        AGENT_FINDINGS_SCHEMA
      ),
    ]);

    // D. 各Agent結果をパースしてDB保存
    const agentData = [
      { role: "notation", raw: agent1Result },
      { role: "structure", raw: agent2Result },
      { role: "semantic", raw: agent3Result },
    ];

    const allFindings: any[] = [];

    for (const agent of agentData) {
      let findings: any[] = [];
      try { findings = JSON.parse(agent.raw); } catch { findings = []; }

      allFindings.push(...findings.map((f: any) => ({ ...f, agent: agent.role })));

      for (const ms of manuscripts) {
        await supabase.from("normalization_log").insert({
          project_id,
          manuscript_id: ms.id,
          agent_role: agent.role,
          findings,
        });
      }
    }

    // E. 合議結果サマリー
    const criticalCount = allFindings.filter((f) => f.severity === "critical").length;
    const warningCount = allFindings.filter((f) => f.severity === "warning").length;

    // F. フェーズ進行（criticalが0ならPHASE 2へ）
    const nextPhase = criticalCount === 0 ? "phase2" : "phase1";
    await supabase.from("projects").update({
      current_phase: nextPhase,
      updated_at: new Date().toISOString(),
    }).eq("id", project_id);

    return new Response(
      JSON.stringify({
        success: true,
        phase: "PHASE 1 — 入口の合議",
        consensus: {
          total_findings: allFindings.length,
          critical: criticalCount,
          warning: warningCount,
          info: allFindings.length - criticalCount - warningCount,
          next_phase: nextPhase,
        },
        agent_results: {
          notation: JSON.parse(agent1Result || "[]"),
          structure: JSON.parse(agent2Result || "[]"),
          semantic: JSON.parse(agent3Result || "[]"),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
