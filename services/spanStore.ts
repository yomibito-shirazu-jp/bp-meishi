/**
 * spanStore - immer ベースの spans 状態管理（Undo/Redo + 不変性ガード）
 *
 * - produceWithPatches で変更の diff を記録
 * - verified/manual のスパンは AI 再推論時に絶対に上書き・削除されない（mergeInferredSpans）
 * - Undo/Redo スタックで編集履歴を管理
 */

import { produceWithPatches, applyPatches, enablePatches, Patch } from 'immer';
import { Span } from '../types';

enablePatches();

export interface SpanHistoryEntry {
  patches: Patch[];
  inversePatches: Patch[];
}

export interface SpanState {
  spans: Span[];
  past: SpanHistoryEntry[];
  future: SpanHistoryEntry[];
}

export const createSpanState = (initial: Span[] = []): SpanState => ({
  spans: initial,
  past: [],
  future: [],
});

/** 編集を適用し、Undo/Redo スタックを更新 */
export const applySpanEdit = (
  state: SpanState,
  recipe: (draft: Span[]) => void,
): SpanState => {
  const [next, patches, inversePatches] = produceWithPatches(state.spans, recipe);
  if (patches.length === 0) return state;
  return {
    spans: next,
    past: [...state.past, { patches, inversePatches }],
    future: [],
  };
};

/** Undo: 直前の編集を取り消す */
export const undoSpan = (state: SpanState): SpanState => {
  const last = state.past[state.past.length - 1];
  if (!last) return state;
  const spans = applyPatches(state.spans, last.inversePatches);
  return {
    spans,
    past: state.past.slice(0, -1),
    future: [last, ...state.future],
  };
};

/** Redo: 取り消した編集を再適用 */
export const redoSpan = (state: SpanState): SpanState => {
  const next = state.future[0];
  if (!next) return state;
  const spans = applyPatches(state.spans, next.patches);
  return {
    spans,
    past: [...state.past, next],
    future: state.future.slice(1),
  };
};

/**
 * AI の再推論結果を既存の spans にマージする。
 * verified / manual の span は絶対に上書きされない。
 * 既存の inferred span は新しい推論で差し替え、新規要素は追加。
 */
export const mergeInferredSpans = (
  existing: Span[],
  fresh: Span[],
): Span[] => {
  const lockedById = new Map<string, Span>();
  existing.forEach(s => {
    if (s.status === 'verified' || s.status === 'manual') {
      lockedById.set(s.id, s);
    }
  });

  // 新しい推論結果のうち、ロックされていないものだけ受け入れる
  const result: Span[] = [];
  const freshIds = new Set<string>();
  fresh.forEach(s => {
    freshIds.add(s.id);
    if (lockedById.has(s.id)) return; // ロック済は新推論で上書きしない
    result.push({ ...s, status: s.status ?? 'inferred' });
  });

  // ロック済の span を末尾に復元
  lockedById.forEach(locked => result.push(locked));

  return result;
};

/** 統計: inferred / verified / manual の内訳 */
export const countSpansByStatus = (spans: Span[]) => {
  const counts = { inferred: 0, verified: 0, manual: 0 };
  spans.forEach(s => {
    const key = s.status ?? 'inferred';
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return counts;
};
