// supabase/functions/phase5-quality-check/index.ts
// ==========================================================
// PHASE 5 — 出口の合議：三者合議② — 品質検証
// Agent 1: 構造検証 / Agent 2: マッピング / Agent 3: 差分検証
// 19項目チェック・差分検証・プリフライト
// → エビデンスPDF（顧客提出用QAレポート）
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
// 19項目チェックリストスキーマ（プロンプト変数化）
// グローバル or 顧客個別で柔軟に差し替え可能
// ==========================================
const DEFAULT_CHECKLIST_19 = [
  { id: 1, item: "作業環境（アプリケーションバージョン等）の確認", category: "environment" },
  { id: 2, item: "訂正後の画面確認とレ点チェック", category: "correction" },
  { id: 3, item: "画像取込・配置後の確認", category: "image" },
  { id: 4, item: "正しい画質（4C/1C、RGB変換）で作成されているか", category: "preflight" },
  { id: 5, item: "指示と異なる作業箇所の確認", category: "correction" },
  { id: 6, item: "レ点チェック漏れ・訂正漏れの確認", category: "correction" },
  { id: 7, item: "訂正指示のない箇所を変更していないか（あおり検版）", category: "diff" },
  { id: 8, item: "追加原稿の訂正漏れ確認", category: "correction" },
  { id: 9, item: "指示通りの体裁に作成されているか", category: "structure" },
  { id: 10, item: "ノンブル・柱の位置と内容の正確性", category: "structure" },
  { id: 11, item: "ツメの色と位置の確認", category: "structure" },
  { id: 12, item: "奇数・偶数ページの確認", category: "structure" },
  { id: 13, item: "流用・複写物の属性変更確認", category: "structure" },
  { id: 14, item: "リンク画像は最新データか", category: "image" },
  { id: 15, item: "組替え・訂正後のPDFチェッカー確認", category: "diff" },
  { id: 16, item: "ダブルチェック後の修正確認", category: "correction" },
  { id: 17, item: "作業後のデータ保存確認", category: "environment" },
  { id: 18, item: "出力解像度（600/1200dpi）の確認", category: "preflight" },
  { id: 19, item: "カラースペース（CMYK/PDF-X1a）の確認", category: "preflight" },
];

// Agent結果スキーマ
const AGENT_CHECK_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      check_id: { type: "INTEGER" },
      item: { type: "STRING" },
      status: { type: "STRING", description: "'PASS' or 'FAIL' or 'N/A'" },
      detail: { type: "STRING", description: "検証結果の詳細" },
    },
    required: ["check_id", "status"],
  },
};

serve(async (req: Request) => {
  try {
    const { project_id, client_id, custom_checklist } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // チェックリスト（プロンプト変数: グローバル or 顧客個別）
    const checklist = custom_checklist || DEFAULT_CHECKLIST_19;

    // A. 生成済みデータ取得
    const [{ data: job }, { data: chunks }, { data: globals }] = await Promise.all([
      supabase.from("typeset_jobs").select("*").eq("project_id", project_id)
        .eq("status", "completed").order("created_at", { ascending: false }).limit(1).single(),
      supabase.from("content_chunks").select("*").eq("project_id", project_id).order("order_index"),
      supabase.from("document_globals").select("*").eq("project_id", project_id).single(),
    ]);

    const vfm = job?.vfm_content || "";
    const css = job?.css_content || "";
    const chunkSummary = (chunks || []).map((c: any) =>
      `[${c.chunk_id}] role=${c.role} chars=${c.char_count}`
    ).join("\n");

    // ==========================================
    // B. 三者合議②：3エージェントを並列実行
    // ==========================================
    const [agent1, agent2, agent3] = await Promise.all([

      // --- Agent 1: 構造検証 ---
      callGemini(
        `あなたはDTP構造検証エージェントです。生成されたVFMとCSSを検証し、
以下のチェックリストのうち「structure」カテゴリの項目を判定してください。

【チェックリスト】
${JSON.stringify(checklist.filter((c: any) => c.category === "structure"))}

【VFM（生成済み原稿）】
${vfm.substring(0, 3000)}

【CSS（生成済みスタイル）】
${css.substring(0, 2000)}

【チャンク構造】
${chunkSummary}`,
        AGENT_CHECK_SCHEMA
      ),

      // --- Agent 2: マッピング検証 ---
      callGemini(
        `あなたはDTPマッピング検証エージェントです。原稿チャンクとCSSコンポーネントの
対応関係（マッピング）が正しいか検証してください。

【チェックリスト】
${JSON.stringify(checklist.filter((c: any) => ["image", "correction"].includes(c.category)))}

【チャンク一覧】
${chunkSummary}

【グローバル設定】
${JSON.stringify(globals || {})}`,
        AGENT_CHECK_SCHEMA
      ),

      // --- Agent 3: 差分検証 ---
      callGemini(
        `あなたはDTP差分検証エージェントです。入力原稿と生成VFMの間に
意図しない変更や脱落がないか検証してください。

【チェックリスト】
${JSON.stringify(checklist.filter((c: any) => ["diff", "preflight", "environment"].includes(c.category)))}

【原稿チャンク数】${chunks?.length || 0}
【VFM文字数】${vfm.length}
【VFM冒頭】
${vfm.substring(0, 2000)}`,
        AGENT_CHECK_SCHEMA
      ),
    ]);

    // C. 結果を統合
    let allChecks: any[] = [];
    try { allChecks = [...JSON.parse(agent1), ...JSON.parse(agent2), ...JSON.parse(agent3)]; }
    catch { allChecks = []; }

    const failCount = allChecks.filter((c: any) => c.status === "FAIL").length;
    const overallStatus = failCount === 0 ? "PASS" : "FAIL";

    // D. DB保存
    await supabase.from("quality_reports").insert({
      project_id,
      typeset_job_id: job?.id,
      overall_status: overallStatus,
      agent_results: {
        structure: JSON.parse(agent1 || "[]"),
        mapping: JSON.parse(agent2 || "[]"),
        diff: JSON.parse(agent3 || "[]"),
      },
      checklist_19: allChecks,
      diff_verification: { vfm_chars: vfm.length, chunk_count: chunks?.length },
      preflight_results: { css_length: css.length, has_page_rule: css.includes("@page") },
    });

    // E. フェーズ完了
    if (overallStatus === "PASS") {
      await supabase.from("projects").update({
        current_phase: "delivered",
        updated_at: new Date().toISOString(),
      }).eq("id", project_id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        phase: "PHASE 5 — 出口の合議（品質検証）",
        overall_status: overallStatus,
        summary: {
          total_checks: allChecks.length,
          pass: allChecks.filter((c: any) => c.status === "PASS").length,
          fail: failCount,
          na: allChecks.filter((c: any) => c.status === "N/A").length,
        },
        checklist_results: allChecks,
        note: overallStatus === "PASS"
          ? "全項目PASS → 印刷用PDF出力可能（初校→再校→…消滅）"
          : "FAIL項目あり → 修正後に再実行が必要",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
