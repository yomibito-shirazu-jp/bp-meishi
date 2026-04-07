// frontend/ConsensusReportDashboard.tsx
// ==========================================================
// 「読み人知らず」第一レポート — 合議ダッシュボード
// ユーザーが検証結果を確認し、承認/修正/棄却するUI
// NEEDS_REVISION 中は「PDF生成」ボタンがブロックされる
// ==========================================================

"use client";

import { useState, useCallback, useMemo } from "react";

// ------------------------------------------
// 型定義（Edge Functionからの戻り値と一致）
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

interface FeedbackEntry {
  chunk_id: string;
  original: string;
  ai_suggestion: string | null;
  user_final: string;
  action_type: "ACCEPTED" | "MANUAL_OVERRIDE" | "REJECTED";
  chunk_role: string;
}

// ------------------------------------------
// Props
// ------------------------------------------
interface Props {
  report: ConsensusReport;
  supabaseUrl: string;
  supabaseAnonKey: string;
  clientId: string;
  onTypesettingReady?: () => void;
}

export default function ConsensusReportDashboard({
  report: initialReport,
  supabaseUrl,
  supabaseAnonKey,
  clientId,
  onTypesettingReady,
}: Props) {
  const [report, setReport] = useState(initialReport);
  const [editTexts, setEditTexts] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<Record<string, "ACCEPTED" | "MANUAL_OVERRIDE" | "REJECTED">>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // NG項目のみ抽出
  const ngItems = useMemo(
    () => report.component_details.filter((d) => d.status === "NG"),
    [report]
  );

  const okItems = useMemo(
    () => report.component_details.filter((d) => d.status === "OK"),
    [report]
  );

  // 全NG項目が処理済みか
  const allNgDecided = useMemo(
    () => ngItems.every((item) => decisions[item.chunk_id]),
    [ngItems, decisions]
  );

  // PDF生成ボタンの活性条件
  const canTypeset = report.summary.status === "READY_FOR_TYPESETTING" || (allNgDecided && !submitting);

  // ------------------------------------------
  // ユーザーアクション
  // ------------------------------------------

  // AI提案を受け入れる
  const handleAccept = useCallback((chunkId: string, suggestedAction: string) => {
    setDecisions((prev) => ({ ...prev, [chunkId]: "ACCEPTED" }));
    // 提案テキストを反映（提案が具体的なテキスト置換の場合）
    setEditTexts((prev) => ({ ...prev, [chunkId]: suggestedAction }));
  }, []);

  // ユーザーが手動修正
  const handleManualEdit = useCallback((chunkId: string, text: string) => {
    setEditTexts((prev) => ({ ...prev, [chunkId]: text }));
    setDecisions((prev) => ({ ...prev, [chunkId]: "MANUAL_OVERRIDE" }));
  }, []);

  // エラーを無視（棄却）
  const handleReject = useCallback((chunkId: string) => {
    setDecisions((prev) => ({ ...prev, [chunkId]: "REJECTED" }));
  }, []);

  // ------------------------------------------
  // PDCAフィードバック送信 → Vivliostyleへ
  // ------------------------------------------
  const handleSubmitAndTypeset = useCallback(async () => {
    setSubmitting(true);

    // フィードバックデータを構築
    const feedbacks: FeedbackEntry[] = ngItems
      .filter((item) => decisions[item.chunk_id])
      .map((item) => {
        const firstError = item.validation_errors[0];
        return {
          chunk_id: item.chunk_id,
          original: item.current_text,
          ai_suggestion: firstError?.suggested_action || null,
          user_final: editTexts[item.chunk_id] || item.current_text,
          action_type: decisions[item.chunk_id],
          chunk_role: item.component_type,
        };
      });

    try {
      // PDCAフィードバックAPIを呼び出し
      const resp = await fetch(`${supabaseUrl}/functions/v1/pdca-feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({
          project_id: report.project_id,
          client_id: clientId,
          feedbacks,
        }),
      });

      const result = await resp.json();
      if (result.success) {
        setSubmitted(true);
        onTypesettingReady?.();
      }
    } catch (err) {
      console.error("PDCA feedback failed:", err);
    } finally {
      setSubmitting(false);
    }
  }, [ngItems, decisions, editTexts, report, supabaseUrl, supabaseAnonKey, clientId, onTypesettingReady]);

  // ------------------------------------------
  // レンダリング
  // ------------------------------------------
  if (submitted) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>✅</div>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 500, marginBottom: "0.5rem" }}>
          検証完了 — Vivliostyle組版エンジンへ送信可能
        </h2>
        <p style={{ color: "var(--color-text-secondary)" }}>
          PDCAフィードバックが記録されました。次回の検証精度が向上します。
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "1rem" }}>
      {/* ===== サマリーヘッダー ===== */}
      <div
        style={{
          padding: "1.5rem",
          borderRadius: 12,
          border: `1px solid ${report.summary.status === "READY_FOR_TYPESETTING" ? "var(--color-border-success)" : "var(--color-border-warning)"}`,
          background: report.summary.status === "READY_FOR_TYPESETTING" ? "var(--color-background-success)" : "var(--color-background-warning)",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 500, margin: 0 }}>
              第一レポート（合議結果）
            </h1>
            <p style={{ margin: "0.25rem 0 0", color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>
              {report.report_id} — {new Date(report.generated_at).toLocaleString("ja-JP")}
            </p>
          </div>
          <div
            style={{
              padding: "0.5rem 1rem",
              borderRadius: 8,
              fontWeight: 500,
              fontSize: "0.875rem",
              background: report.summary.status === "READY_FOR_TYPESETTING" ? "#097550" : "#854F0B",
              color: "#fff",
            }}
          >
            {report.summary.status === "READY_FOR_TYPESETTING" ? "READY" : "要修正"}
          </div>
        </div>

        {/* エラーカウント */}
        <div style={{ display: "flex", gap: "1.5rem", marginTop: "1rem", fontSize: "0.875rem" }}>
          <span>全{report.summary.total_components}件</span>
          <span style={{ color: "var(--color-text-success)" }}>
            OK: {report.summary.total_components - ngItems.length}
          </span>
          {report.summary.error_count.overflow > 0 && (
            <span style={{ color: "var(--color-text-danger)" }}>
              文字あふれ: {report.summary.error_count.overflow}
            </span>
          )}
          {report.summary.error_count.rule_violation > 0 && (
            <span style={{ color: "var(--color-text-warning)" }}>
              ルール違反: {report.summary.error_count.rule_violation}
            </span>
          )}
        </div>
      </div>

      {/* ===== NG項目（要対応） ===== */}
      {ngItems.length > 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 500, marginBottom: "0.75rem" }}>
            要対応（{ngItems.length}件）
          </h2>
          {ngItems.map((item) => (
            <div
              key={item.chunk_id}
              style={{
                border: "1px solid var(--color-border-warning)",
                borderRadius: 12,
                padding: "1rem",
                marginBottom: "0.75rem",
                background: decisions[item.chunk_id] ? "var(--color-background-secondary)" : "transparent",
                opacity: decisions[item.chunk_id] ? 0.7 : 1,
                transition: "all 0.2s",
              }}
            >
              {/* ヘッダー */}
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                <div>
                  <span style={{ fontWeight: 500 }}>
                    {decisions[item.chunk_id] ? "✅" : "❌"} {item.component_name}
                  </span>
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: "0.75rem",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: "var(--color-background-tertiary)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {item.component_type}
                  </span>
                </div>
                <span style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
                  {item.writing_mode === "vertical-rl" ? "縦組み" : "横組み"} |
                  {item.char_count}字{item.max_chars ? ` / 上限${item.max_chars}字` : ""}
                </span>
              </div>

              {/* エラーリスト */}
              {item.validation_errors.map((err, ei) => (
                <div
                  key={ei}
                  style={{
                    padding: "0.75rem",
                    borderRadius: 8,
                    border: "1px solid var(--color-border-tertiary)",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, marginBottom: "0.25rem" }}>
                    <span
                      style={{
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        background: err.error_type === "文字あふれ" ? "var(--color-background-danger)" : "var(--color-background-warning)",
                        color: err.error_type === "文字あふれ" ? "var(--color-text-danger)" : "var(--color-text-warning)",
                      }}
                    >
                      {err.error_type}
                    </span>
                    <span style={{ color: "var(--color-text-secondary)", fontSize: "0.75rem" }}>
                      {err.reason_ref}
                    </span>
                  </div>
                  <p style={{ margin: "0.25rem 0" }}>{err.suggested_action}</p>
                  {err.original_text && (
                    <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                      対象: 「{err.original_text}」
                    </p>
                  )}
                </div>
              ))}

              {/* アクションボタン */}
              {!decisions[item.chunk_id] && (
                <div style={{ display: "flex", gap: 8, marginTop: "0.75rem" }}>
                  <button
                    onClick={() => handleAccept(item.chunk_id, item.validation_errors[0]?.suggested_action || "")}
                    style={{
                      padding: "6px 16px",
                      borderRadius: 8,
                      border: "1px solid var(--color-border-success)",
                      background: "var(--color-background-success)",
                      color: "var(--color-text-success)",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                      fontWeight: 500,
                    }}
                  >
                    提案を受け入れる
                  </button>
                  <button
                    onClick={() => {
                      const newText = prompt("修正テキストを入力:", item.current_text);
                      if (newText !== null) handleManualEdit(item.chunk_id, newText);
                    }}
                    style={{
                      padding: "6px 16px",
                      borderRadius: 8,
                      border: "1px solid var(--color-border-secondary)",
                      background: "transparent",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                    }}
                  >
                    自分で修正
                  </button>
                  <button
                    onClick={() => handleReject(item.chunk_id)}
                    style={{
                      padding: "6px 16px",
                      borderRadius: 8,
                      border: "1px solid var(--color-border-tertiary)",
                      background: "transparent",
                      color: "var(--color-text-secondary)",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                    }}
                  >
                    無視する
                  </button>
                </div>
              )}

              {/* 決定済みの表示 */}
              {decisions[item.chunk_id] && (
                <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                  {decisions[item.chunk_id] === "ACCEPTED" && "→ AI提案を受け入れ"}
                  {decisions[item.chunk_id] === "MANUAL_OVERRIDE" && `→ 手動修正: 「${editTexts[item.chunk_id]}」`}
                  {decisions[item.chunk_id] === "REJECTED" && "→ 無視（このまま進行）"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ===== OK項目（折りたたみ） ===== */}
      {okItems.length > 0 && (
        <details style={{ marginBottom: "2rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "1rem", fontWeight: 500, marginBottom: "0.75rem" }}>
            OK（{okItems.length}件） — クリックで展開
          </summary>
          {okItems.map((item) => (
            <div
              key={item.chunk_id}
              style={{
                border: "1px solid var(--color-border-tertiary)",
                borderRadius: 8,
                padding: "0.75rem",
                marginBottom: "0.5rem",
                fontSize: "0.875rem",
              }}
            >
              <span style={{ color: "var(--color-text-success)", fontWeight: 500 }}>✓</span>{" "}
              <span style={{ fontWeight: 500 }}>{item.component_name}</span>
              <span style={{ marginLeft: 8, color: "var(--color-text-secondary)", fontSize: "0.75rem" }}>
                {item.char_count}字
                {item.max_chars ? ` / ${item.max_chars}字` : ""}
              </span>
            </div>
          ))}
        </details>
      )}

      {/* ===== PDF生成ボタン（ゲート） ===== */}
      <div style={{ textAlign: "center", padding: "1rem 0" }}>
        <button
          disabled={!canTypeset}
          onClick={handleSubmitAndTypeset}
          style={{
            padding: "12px 48px",
            borderRadius: 12,
            border: "none",
            fontSize: "1rem",
            fontWeight: 500,
            cursor: canTypeset ? "pointer" : "not-allowed",
            background: canTypeset ? "#097550" : "var(--color-background-tertiary)",
            color: canTypeset ? "#fff" : "var(--color-text-secondary)",
            transition: "all 0.2s",
          }}
        >
          {submitting
            ? "送信中..."
            : canTypeset
              ? "確定して Vivliostyle に送る →"
              : `残り${ngItems.length - Object.keys(decisions).length}件の対応が必要`}
        </button>
        {!canTypeset && (
          <p style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
            すべてのNG項目に対応するまでPDF生成はブロックされます
          </p>
        )}
      </div>
    </div>
  );
}
