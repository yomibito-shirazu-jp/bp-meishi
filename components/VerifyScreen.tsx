/**
 * VerifyScreen - HITL 確定フェーズの画面本体
 *
 * 分析直後にユーザーを強制的に通す画面。
 *   左: VerifyCanvas（fabric.js ベクター編集）
 *   右: 検出要素一覧 + 承認/修正/削除 + Undo/Redo + 統計
 *
 * 全要素が verified/manual になるまで「確定 → 編集へ」ボタンは非活性。
 */

import React, { useMemo, useCallback, useEffect } from 'react';
import {
  Check, Trash2, Undo2, Redo2, CheckCircle2,
  AlertTriangle, Plus, ArrowRight, Type, Sparkles,
  Eye, EyeOff, FileDown,
} from 'lucide-react';
import { Span } from '../types';
import VerifyCanvas from './VerifyCanvas';
import {
  SpanState, applySpanEdit, undoSpan, redoSpan, countSpansByStatus,
} from '../services/spanStore';
import { exportCardAsPdfBytes, downloadPdfBytes } from '../services/pdfExport';

export interface VerifyScreenProps {
  spanState: SpanState;
  setSpanState: React.Dispatch<React.SetStateAction<SpanState>>;
  pageMM: [number, number];
  bgPngDataUrl?: string | null;
  onConfirm: (finalSpans: Span[]) => void;   // 全確定後「編集へ」
  onBack: () => void;                         // 戻る
}

export const VerifyScreen: React.FC<VerifyScreenProps> = ({
  spanState, setSpanState, pageMM, bgPngDataUrl, onConfirm, onBack,
}) => {
  const { spans, past, future } = spanState;
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<'all' | 'pending' | 'verified'>('pending');
  const [showBg, setShowBg] = React.useState(true);  // 元PNG 表示切替（ベクター専用プレビュー）

  const counts = useMemo(() => countSpansByStatus(spans), [spans]);
  const pending = counts.inferred;
  const total = spans.length;
  const allDone = total > 0 && pending === 0;
  const pct = total > 0 ? Math.round(((total - pending) / total) * 100) : 0;

  // ── アクション ──
  const setStatus = useCallback((id: string, status: Span['status']) => {
    setSpanState(s => applySpanEdit(s, draft => {
      const i = draft.findIndex(x => x.id === id);
      if (i >= 0) draft[i].status = status;
    }));
  }, [setSpanState]);

  const verifyOne = useCallback((id: string) => setStatus(id, 'verified'), [setStatus]);

  const verifyAll = useCallback(() => {
    setSpanState(s => applySpanEdit(s, draft => {
      draft.forEach(sp => {
        if (sp.status !== 'manual') sp.status = 'verified';
      });
    }));
  }, [setSpanState]);

  const editSpan = useCallback((id: string, patch: Partial<Span>) => {
    setSpanState(s => applySpanEdit(s, draft => {
      const i = draft.findIndex(x => x.id === id);
      if (i < 0) return;
      Object.assign(draft[i], patch);
      // 人間が編集した = 暗黙的に確定扱いへ（元が inferred の場合のみ昇格）
      if (draft[i].status === 'inferred') draft[i].status = 'verified';
    }));
  }, [setSpanState]);

  const addSpan = useCallback((span: Span) => {
    setSpanState(s => applySpanEdit(s, draft => {
      draft.push({ ...span, status: span.status ?? 'manual' });
    }));
  }, [setSpanState]);

  const deleteSpan = useCallback((id: string) => {
    setSpanState(s => applySpanEdit(s, draft => {
      const i = draft.findIndex(x => x.id === id);
      if (i >= 0) draft.splice(i, 1);
    }));
    if (selectedId === id) setSelectedId(null);
  }, [setSpanState, selectedId]);

  // ── キーボードショートカット ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault(); setSpanState(undoSpan);
      } else if ((e.ctrlKey || e.metaKey) && (e.shiftKey && e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        e.preventDefault(); setSpanState(redoSpan);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setSpanState]);

  // ── 表示用フィルタ ──
  const visible = spans.filter(s => {
    if (filter === 'pending') return s.status === 'inferred';
    if (filter === 'verified') return s.status === 'verified' || s.status === 'manual';
    return true;
  });


  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: '#f1f5f9' }}>
      {/* Top bar */}
      <div className="h-14 px-5 flex items-center justify-between shrink-0 border-b" style={{ background: '#fff', borderColor: '#e5e7eb' }}>
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-800">← 戻る</button>
          <div>
            <div className="text-[13px] font-bold text-slate-800 flex items-center gap-2">
              <Sparkles size={14} style={{ color: '#6366f1' }} />
              検出結果の確認（Step 2: HITL 確定）
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              すべての要素を確認して「確定→編集へ」で次のステップに進みます
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSpanState(undoSpan)}
            disabled={past.length === 0}
            className="w-9 h-9 rounded-lg border flex items-center justify-center transition-colors hover:bg-slate-50 disabled:opacity-30"
            style={{ borderColor: '#e5e7eb' }}
            title="元に戻す (Ctrl+Z)"
          ><Undo2 size={15} /></button>
          <button
            onClick={() => setSpanState(redoSpan)}
            disabled={future.length === 0}
            className="w-9 h-9 rounded-lg border flex items-center justify-center transition-colors hover:bg-slate-50 disabled:opacity-30"
            style={{ borderColor: '#e5e7eb' }}
            title="やり直し (Ctrl+Shift+Z)"
          ><Redo2 size={15} /></button>

          <div className="mx-2 text-[11px] text-slate-500">
            <span className="font-bold text-amber-600">{pending}</span>件 未確認 /
            <span className="font-bold text-emerald-600 ml-1">{counts.verified}</span>件 確定 /
            <span className="font-bold text-violet-600 ml-1">{counts.manual}</span>件 手動
            <span className="ml-2">（{pct}%）</span>
          </div>

          <button
            onClick={() => setShowBg(v => !v)}
            className="w-9 h-9 rounded-lg border flex items-center justify-center transition-colors hover:bg-slate-50"
            style={{
              borderColor: showBg ? '#e5e7eb' : '#8b5cf6',
              background: showBg ? '#fff' : 'rgba(139,92,246,0.08)',
              color: showBg ? '#475569' : '#8b5cf6',
            }}
            title={showBg ? '元PDF背景を隠して純ベクタービュー' : '元PDF背景を表示'}
          >
            {showBg ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>

          <button
            onClick={verifyAll}
            disabled={pending === 0}
            className="text-xs font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-30"
            style={{ background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0' }}
          >
            未確認を一括確定
          </button>

          <button
            onClick={async () => {
              // 確定済データだけで真のベクターPDFを生成
              const title = spans.find(s => s.font_class === 'mincho')?.text?.slice(0, 30) || '名刺';
              try {
                const bytes = await exportCardAsPdfBytes({
                  spans,
                  pageMM,
                  bgPngBase64: null,          // 背景PNG無し = 純ベクター
                  coverOriginals: false,
                  statusFilter: counts.verified + counts.manual > 0 ? 'verified' : 'all',
                  title,
                });
                downloadPdfBytes(bytes, `${title}_vector.pdf`);
              } catch (e: any) {
                console.error('[VerifyScreen] vector PDF export failed', e);
                alert('ベクターPDF生成エラー: ' + (e?.message || e));
              }
            }}
            disabled={spans.length === 0}
            className="text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-30"
            style={{ background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe' }}
            title="確定済spansのみを使った真のベクターPDFをダウンロード（検索可能・印刷品質）"
          >
            <FileDown size={13} /> ベクターPDFプレビュー
          </button>

          <button
            onClick={() => onConfirm(spans)}
            disabled={!allDone}
            className={`text-[13px] font-bold px-4 py-2 rounded-xl flex items-center gap-2 shadow-md transition-all
              ${allDone ? 'hover:shadow-lg hover:scale-[1.02] text-white' : 'opacity-40 cursor-not-allowed bg-slate-300 text-slate-500'}`}
            style={allDone ? { background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' } : {}}
            title={allDone ? '確定データで編集画面へ' : `残り${pending}件を確認してください`}
          >
            確定 → 編集へ <ArrowRight size={15} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Canvas */}
        <div className="flex-1 overflow-hidden">
          <VerifyCanvas
            spans={spans}
            pageMM={pageMM}
            bgPngDataUrl={showBg ? (bgPngDataUrl ?? null) : null}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSpanChange={editSpan}
            onSpanAdd={addSpan}
            onSpanDelete={deleteSpan}
          />
        </div>

        {/* Right: Span list */}
        <div className="w-[380px] shrink-0 border-l flex flex-col overflow-hidden" style={{ background: '#fff', borderColor: '#e5e7eb' }}>
          {/* ★ 統合承認: カード全文を1画面に集約表示、ボタン1つで全確定＋編集遷移 ★ */}
          <div className="px-4 pt-3 pb-3 border-b" style={{ borderColor: '#f1f5f9' }}>
            <div className="text-[11px] font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
              <Sparkles size={11} style={{ color: '#6366f1' }} />
              AI が読み取った全テキスト（左のプレビューと照合）
            </div>
            <div
              className="max-h-[40vh] overflow-y-auto rounded-lg border px-3 py-2 text-[12px] leading-relaxed text-slate-800 whitespace-pre-wrap"
              style={{ background: '#fafafa', borderColor: '#e5e7eb' }}
            >
              {spans.map(s => s.text || '（空）').join('\n') || '（検出なし）'}
            </div>
            <button
              onClick={() => {
                // 全件確定 + 即時 onConfirm
                setSpanState(s => applySpanEdit(s, draft => {
                  draft.forEach(sp => { if (sp.status !== 'manual') sp.status = 'verified'; });
                }));
                // React 状態更新後に confirm する
                setTimeout(() => onConfirm(spans.map(sp => ({ ...sp, status: sp.status === 'manual' ? 'manual' : 'verified' }))), 50);
              }}
              disabled={spans.length === 0}
              className="w-full mt-3 py-2.5 rounded-xl text-[13px] font-bold text-white shadow-md transition-all hover:shadow-lg disabled:opacity-40 flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
            >
              <CheckCircle2 size={15} /> 内容を確認した → 編集へ進む
            </button>
            <p className="text-[10px] text-slate-500 mt-1.5 text-center">
              左のカードで位置/フォントを直接編集できます。個別調整は下の一覧で。
            </p>
          </div>

          {/* Progress */}
          <div className="px-4 pt-3 pb-2">
            <div className="flex items-center justify-between text-[11px] text-slate-600 mb-1.5">
              <span className="font-bold">個別調整（必要な場合のみ）</span>
              <span className="font-mono">{total - pending}/{total}</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#f1f5f9' }}>
              <div
                className="h-full transition-all"
                style={{ width: `${pct}%`, background: allDone ? '#10b981' : '#6366f1' }}
              />
            </div>
          </div>

          {/* Filter */}
          <div className="px-4 py-2 flex items-center gap-1">
            {([
              { k: 'pending' as const, label: `未確認 (${pending})`, color: '#f59e0b' },
              { k: 'verified' as const, label: `確定済 (${counts.verified + counts.manual})`, color: '#10b981' },
              { k: 'all' as const, label: `全件 (${total})`, color: '#6366f1' },
            ]).map(f => (
              <button
                key={f.k}
                onClick={() => setFilter(f.k)}
                className="text-[11px] px-2.5 py-1 rounded-full font-semibold transition-colors"
                style={{
                  background: filter === f.k ? f.color : '#f1f5f9',
                  color: filter === f.k ? '#fff' : '#475569',
                }}
              >{f.label}</button>
            ))}
          </div>

          {/* 個別調整（必要な場合のみ） */}
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            {visible.length === 0 && (
              <div className="text-center text-[12px] text-slate-400 py-12">
                {filter === 'pending' ? '✅ 未確認の要素はありません' : '該当要素なし'}
              </div>
            )}
            {visible.map(s => {
              const isSelected = selectedId === s.id;
              const statusColor = s.status === 'verified' ? '#10b981' : s.status === 'manual' ? '#8b5cf6' : '#f59e0b';
              const statusLabel = s.status === 'verified' ? '確定' : s.status === 'manual' ? '手動' : '未確認';
              return (
                <div
                  key={s.id}
                  onClick={() => setSelectedId(isSelected ? null : s.id)}
                  className="px-3 py-2.5 rounded-lg mb-1 cursor-pointer transition-all border"
                  style={{
                    background: isSelected ? 'rgba(99,102,241,0.06)' : 'transparent',
                    borderColor: isSelected ? 'rgba(99,102,241,0.3)' : 'transparent',
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5"
                      style={{ background: `${statusColor}20`, color: statusColor }}
                    >{statusLabel}</span>
                    <Type size={12} className="text-slate-400 shrink-0 mt-1" />
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        value={s.text}
                        onChange={e => editSpan(s.id, { text: e.target.value })}
                        onClick={e => e.stopPropagation()}
                        className="w-full text-[12px] font-medium text-slate-800 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-indigo-300 focus:outline-none"
                        placeholder="(空)"
                      />
                      <div className="text-[9px] text-slate-400 mt-0.5 font-mono">
                        {s.font_class} {s.size_pt}pt · {s.writing_direction === 'vertical' ? '縦' : '横'} ·
                        ({s.x_pct.toFixed(1)}, {s.y_pct.toFixed(1)}) {s.w_pct.toFixed(1)}×{s.h_pct.toFixed(1)}%
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col gap-1 ml-1">
                      {s.status !== 'verified' && s.status !== 'manual' && (
                        <button
                          onClick={e => { e.stopPropagation(); verifyOne(s.id); }}
                          className="w-6 h-6 rounded flex items-center justify-center hover:bg-emerald-50"
                          title="確定"
                        ><Check size={13} className="text-emerald-600" /></button>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); deleteSpan(s.id); }}
                        className="w-6 h-6 rounded flex items-center justify-center hover:bg-red-50"
                        title="削除"
                      ><Trash2 size={12} className="text-red-500" /></button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer tips */}
          <div className="px-4 py-3 border-t" style={{ borderColor: '#f1f5f9' }}>
            {allDone ? (
              <div className="text-[11px] text-emerald-700 font-semibold flex items-center gap-1.5">
                <CheckCircle2 size={13} /> 全要素確認完了。上の「確定→編集へ」で次へ
              </div>
            ) : (
              <div className="text-[11px] text-amber-700 font-semibold flex items-center gap-1.5">
                <AlertTriangle size={13} /> 残り{pending}件。名刺情報の誤りは刷り直しの損失に直結します
              </div>
            )}
            <div className="text-[10px] text-slate-400 mt-2">
              <Plus size={10} className="inline mr-1" />
              Canvas の空白をドラッグ → 新規テキスト追加 / Delete で選択削除
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              Ctrl+Z / Ctrl+Shift+Z で Undo/Redo
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VerifyScreen;
