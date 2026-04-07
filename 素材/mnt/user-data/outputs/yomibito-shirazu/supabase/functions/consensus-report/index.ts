// supabase/functions/consensus-report/index.ts
// ==========================================================
// 「読み人知らず」第一レポート（合議ダッシュボード）API
// 構造抽出（箱）× RAG検証（中身）→ 合議結果JSON → フロントエンドUI
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ------------------------------------------
// 第一レポート（ConsensusReport）の型
// ------------------------------------------
interface ConsensusReport {
  report_id: string;
  generated_at: string;
  project_id: string;
  summary: {
    status: "READY_FOR_TYPESETTING" | "NEEDS_REVISION";
    total_components: number;
    error_count: {
      overflow: number;
      rule_violation: number;
      other: number;
    };
  };
  component_details: ComponentDetail[];
}

interface ComponentDetail {
  chunk_id: string;
  component_type: string;
  component_name: string;
  status: "OK" | "NG";
  char_count: number;
  max_chars: number | null;
  writing_mode: string;
  layout_constraint: Record<string, unknown>;
  current_text: string;
  validation_errors: ValidationError[];
}

interface ValidationError {
  error_type: string;
  original_text?: string;
  suggested_action: string;
  reason_ref: string;
}

serve(async (req: Request) => {
  try {
    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ------------------------------------------
    // A. 必要なデータをすべてDB から取得
    // ------------------------------------------

    // 原稿チャンク（コンポーネント情報を含む）
    const { data: chunks } = await supabase
      .from("content_chunks")
      .select("*, components(*)")
      .eq("project_id", project_id)
      .order("order_index");

    // 最新のRAG検証レポート
    const { data: ragReport } = await supabase
      .from("validation_reports")
      .select("*")
      .eq("project_id", project_id)
      .eq("report_type", "rag")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!chunks || chunks.length === 0) {
      return new Response(JSON.stringify({ error: "No chunks found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ------------------------------------------
    // B. 構造制約 × RAG検証結果 を合議（マージ）
    // ------------------------------------------
    const ragDetails: any[] = ragReport?.component_details || [];
    let overflowErrors = 0;
    let ruleErrors = 0;
    let otherErrors = 0;

    const componentDetails: ComponentDetail[] = chunks.map((chunk: any) => {
      const comp = chunk.components;
      const ragResult = ragDetails.find((r: any) => r.chunk_id === chunk.chunk_id);

      const isNg = ragResult?.status === "NG";
      const errors: ValidationError[] = (ragResult?.errors || []).map((e: any) => {
        // エラー種別を集計
        if (e.error_type === "文字あふれ") overflowErrors++;
        else if (e.error_type === "表記ルール違反") ruleErrors++;
        else otherErrors++;
        return e;
      });

      // 構造制約からもオーバーフローを独自検知（ダブルチェック）
      if (comp?.max_chars && chunk.char_count > comp.max_chars) {
        const alreadyDetected = errors.some((e) => e.error_type === "文字あふれ");
        if (!alreadyDetected) {
          overflowErrors++;
          errors.push({
            error_type: "文字あふれ",
            suggested_action: `${chunk.char_count - comp.max_chars}文字削減してください（上限: ${comp.max_chars}字）`,
            reason_ref: "構造制約: max_chars超過（PGチェック）",
          });
        }
      }

      return {
        chunk_id: chunk.chunk_id,
        component_type: comp?.component_type || chunk.role,
        component_name: comp?.component_name || chunk.role,
        status: isNg || (comp?.max_chars && chunk.char_count > comp.max_chars) ? "NG" : "OK",
        char_count: chunk.char_count,
        max_chars: comp?.max_chars || null,
        writing_mode: comp?.writing_mode || "vertical-rl",
        layout_constraint: comp?.style_payload || {},
        current_text: chunk.text_content,
        validation_errors: errors,
      };
    });

    // ------------------------------------------
    // C. 全体サマリー（1つでもNGなら NEEDS_REVISION）
    // ------------------------------------------
    const totalErrors = overflowErrors + ruleErrors + otherErrors;
    const overallStatus = totalErrors === 0 ? "READY_FOR_TYPESETTING" : "NEEDS_REVISION";

    const report: ConsensusReport = {
      report_id: `rep_${Date.now()}`,
      generated_at: new Date().toISOString(),
      project_id,
      summary: {
        status: overallStatus,
        total_components: chunks.length,
        error_count: {
          overflow: overflowErrors,
          rule_violation: ruleErrors,
          other: otherErrors,
        },
      },
      component_details: componentDetails,
    };

    // ------------------------------------------
    // D. 合議レポートをDB に保存
    // ------------------------------------------
    await supabase.from("validation_reports").insert({
      project_id,
      report_type: "consensus",
      status: overallStatus,
      summary: report.summary,
      component_details: report.component_details,
    });

    // プロジェクトステータスを更新
    await supabase
      .from("projects")
      .update({
        status: overallStatus === "READY_FOR_TYPESETTING" ? "ready" : "validating",
        updated_at: new Date().toISOString(),
      })
      .eq("id", project_id);

    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
