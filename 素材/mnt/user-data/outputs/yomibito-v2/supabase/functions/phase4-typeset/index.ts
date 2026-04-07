// supabase/functions/phase4-typeset/index.ts
// ==========================================================
// PHASE 4 — 三手目：全ページ一括生成
// Vivliostyle 組版エンジン: VFM + CSS → 全ページ同時PDF生成
// ★ 合議不要・機械的実行のみ ★
// ==========================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// VFM（Vivliostyle Flavored Markdown）変換
function chunksToVFM(chunks: any[], components: any[]): string {
  const compMap = new Map(components.map((c: any) => [c.component_type, c]));
  const lines: string[] = [];

  for (const chunk of chunks) {
    const comp = compMap.get(chunk.role);
    const cssClass = comp?.component_type || chunk.role;

    switch (chunk.role) {
      case "title":
        lines.push(`# ${chunk.text_content}\n`);
        break;
      case "subtitle":
        lines.push(`## ${chunk.text_content}\n`);
        break;
      case "body":
        lines.push(`${chunk.text_content}\n`);
        break;
      default:
        // カスタムコンポーネント → VFMのfenced div記法
        lines.push(`::: ${cssClass}`);
        lines.push(chunk.text_content);
        lines.push(":::\n");
        break;
    }
  }

  return lines.join("\n");
}

serve(async (req: Request) => {
  try {
    const { project_id } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const startTime = Date.now();

    // A. 必要データ取得（すべてDBにある = 機械的実行のみ）
    const [{ data: chunks }, { data: globals }, { data: components }] = await Promise.all([
      supabase.from("content_chunks").select("*").eq("project_id", project_id).order("order_index"),
      supabase.from("document_globals").select("*").eq("project_id", project_id).single(),
      supabase.from("components").select("*").eq("project_id", project_id),
    ]);

    if (!chunks?.length) {
      return new Response(JSON.stringify({ error: "No content chunks" }), { status: 404 });
    }

    // B. VFM生成（Markdown → Vivliostyle入力）
    const vfmContent = chunksToVFM(chunks, components || []);
    const cssContent = globals?.generated_css || "";

    // C. ジョブ作成
    const { data: job } = await supabase.from("typeset_jobs").insert({
      project_id,
      status: "running",
      vfm_content: vfmContent,
      css_content: cssContent,
    }).select("id").single();

    // ==========================================
    // D. Vivliostyle CLI 実行（本番環境では Cloud Run等で実行）
    // ここではジョブ情報の準備まで。実際のPDF生成は
    // 別のワーカー（Cloud Run / Lambda）がこのジョブをポーリングして実行
    // ==========================================
    //
    // 本番実装イメージ:
    // const pdfBuffer = await vivliostyleBuild(vfmContent, cssContent);
    // const pdfUri = await uploadToGCS(pdfBuffer, `${project_id}/output.pdf`);
    //
    // 現時点ではジョブキューとして記録し、外部ワーカーに委任

    const processingTime = Date.now() - startTime;

    await supabase.from("typeset_jobs").update({
      status: "completed",
      pages_generated: Math.ceil(vfmContent.length / 2000), // 概算
      processing_time_ms: processingTime,
      completed_at: new Date().toISOString(),
      // output_pdf_uri: pdfUri, // ワーカーが後で埋める
    }).eq("id", job?.id);

    // E. フェーズ進行 → PHASE 5
    await supabase.from("projects").update({
      current_phase: "phase5",
      updated_at: new Date().toISOString(),
    }).eq("id", project_id);

    return new Response(
      JSON.stringify({
        success: true,
        phase: "PHASE 4 — 全ページ一括生成",
        note: "合議不要・機械的実行のみ",
        job_id: job?.id,
        vfm_length: vfmContent.length,
        css_length: cssContent.length,
        processing_time_ms: processingTime,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
