import React, { useMemo, useState } from 'react';
import { CheckCircle2, Circle, Type, Image as ImageIcon, LayoutTemplate, Barcode } from 'lucide-react';
import { Span, ImageInfo, LayoutBlock, BarcodeInfo } from '../types';

/**
 * 検出要素全件レビュー・パネル
 * - spans (テキスト) + images (画像) + layout_blocks + barcodes を1つのテーブルに統合
 * - 各行クリックで onSelect 経由でプレビューにハイライト
 * - チェックボックスで「確認済」マーキング（localStorage にプロジェクトID単位で保持）
 */

export type DetectionItem =
  | { kind: 'span'; id: string; span: Span }
  | { kind: 'image'; id: string; image: ImageInfo }
  | { kind: 'block'; id: string; block: LayoutBlock }
  | { kind: 'barcode'; id: string; barcode: BarcodeInfo };

export interface DetectionReviewProps {
  projectId: string | null;
  spans: Span[];
  images: ImageInfo[];
  layoutBlocks: LayoutBlock[];
  barcodes: BarcodeInfo[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

const STORAGE_KEY = 'bp_meishi_detection_verified';

const loadVerified = (projectId: string | null): Set<string> => {
  if (!projectId) return new Set();
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, string[]>;
    return new Set(all[projectId] || []);
  } catch {
    return new Set();
  }
};

const saveVerified = (projectId: string | null, verified: Set<string>): void => {
  if (!projectId) return;
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, string[]>;
    all[projectId] = Array.from(verified);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
};

const iconFor = (kind: DetectionItem['kind']) => {
  switch (kind) {
    case 'span': return Type;
    case 'image': return ImageIcon;
    case 'block': return LayoutTemplate;
    case 'barcode': return Barcode;
  }
};

const labelFor = (kind: DetectionItem['kind']) => {
  switch (kind) {
    case 'span': return 'テキスト';
    case 'image': return '画像';
    case 'block': return 'ブロック';
    case 'barcode': return 'バーコード';
  }
};

const colorFor = (kind: DetectionItem['kind']) => {
  switch (kind) {
    case 'span': return '#10b981';
    case 'image': return '#3b82f6';
    case 'block': return '#a855f7';
    case 'barcode': return '#ec4899';
  }
};

type FilterKind = 'all' | 'unverified' | DetectionItem['kind'];

export const DetectionReview: React.FC<DetectionReviewProps> = ({
  projectId, spans, images, layoutBlocks, barcodes, selectedId, onSelect, onClose,
}) => {
  const [verified, setVerified] = useState<Set<string>>(() => loadVerified(projectId));
  const [filter, setFilter] = useState<FilterKind>('all');
  const [query, setQuery] = useState('');

  const items: DetectionItem[] = useMemo(() => {
    const out: DetectionItem[] = [];
    spans.forEach(s => out.push({ kind: 'span', id: s.id, span: s }));
    images.forEach(im => out.push({ kind: 'image', id: im.id, image: im }));
    layoutBlocks.forEach(b => out.push({ kind: 'block', id: b.id, block: b }));
    barcodes.forEach(bc => out.push({ kind: 'barcode', id: bc.id, barcode: bc }));
    return out;
  }, [spans, images, layoutBlocks, barcodes]);

  const filtered = useMemo(() => {
    return items.filter(it => {
      if (filter === 'unverified' && verified.has(it.id)) return false;
      if (filter !== 'all' && filter !== 'unverified' && it.kind !== filter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (it.kind === 'span') return it.span.text.toLowerCase().includes(q);
        if (it.kind === 'block') return (it.block.text_preview || '').toLowerCase().includes(q);
        if (it.kind === 'barcode') return (it.barcode.value || '').toLowerCase().includes(q);
        return false;
      }
      return true;
    });
  }, [items, filter, query, verified]);

  const toggleVerified = (id: string) => {
    setVerified(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveVerified(projectId, next);
      return next;
    });
  };

  const markAll = () => {
    const allIds = new Set(items.map(i => i.id));
    setVerified(allIds);
    saveVerified(projectId, allIds);
  };
  const clearAll = () => {
    setVerified(new Set());
    saveVerified(projectId, new Set());
  };

  const stats = {
    total: items.length,
    verified: items.filter(i => verified.has(i.id)).length,
    span: items.filter(i => i.kind === 'span').length,
    image: items.filter(i => i.kind === 'image').length,
    block: items.filter(i => i.kind === 'block').length,
    barcode: items.filter(i => i.kind === 'barcode').length,
  };
  const verifiedPct = stats.total > 0 ? Math.round((stats.verified / stats.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-40 flex bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="ml-auto h-full w-[520px] max-w-[90vw] bg-white shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#e5e7eb' }}>
          <div>
            <h3 className="text-[15px] font-bold text-slate-800">検出一覧</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              全 <span className="font-bold text-slate-800">{stats.total}</span>件 /
              確認済 <span className="font-bold" style={{ color: verifiedPct === 100 ? '#10b981' : '#6366f1' }}>{stats.verified}</span>件（{verifiedPct}%）
            </p>
          </div>
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg hover:bg-slate-100">閉じる</button>
        </div>

        {/* Progress */}
        <div className="px-5 pt-2">
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#f1f5f9' }}>
            <div
              className="h-full transition-all"
              style={{ width: `${verifiedPct}%`, background: verifiedPct === 100 ? '#10b981' : '#6366f1' }}
            />
          </div>
        </div>

        {/* Filter chips */}
        <div className="px-5 py-3 flex items-center gap-1.5 flex-wrap border-b" style={{ borderColor: '#f1f5f9' }}>
          {([
            { k: 'all' as const, label: `全件 (${stats.total})` },
            { k: 'unverified' as const, label: `未確認 (${stats.total - stats.verified})` },
            { k: 'span' as const, label: `テキスト (${stats.span})` },
            { k: 'image' as const, label: `画像 (${stats.image})` },
            { k: 'block' as const, label: `ブロック (${stats.block})` },
            ...(stats.barcode > 0 ? [{ k: 'barcode' as const, label: `バーコード (${stats.barcode})` }] : []),
          ]).map(f => (
            <button
              key={f.k}
              onClick={() => setFilter(f.k)}
              className="text-[11px] px-2.5 py-1 rounded-full font-semibold transition-colors"
              style={{
                background: filter === f.k ? '#6366f1' : '#f1f5f9',
                color: filter === f.k ? '#fff' : '#475569',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Search + bulk actions */}
        <div className="px-5 pt-3 pb-2 flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="テキスト検索..."
            className="flex-1 text-[12px] px-3 py-1.5 rounded-lg border focus:outline-none focus:ring-2 focus:ring-indigo-300"
            style={{ borderColor: '#e5e7eb' }}
          />
          <button onClick={markAll} className="text-[11px] px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 font-semibold hover:bg-emerald-100">全て確認</button>
          <button onClick={clearAll} className="text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100">解除</button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-5">
          {filtered.length === 0 && (
            <div className="text-center text-[12px] text-slate-400 py-12">該当する検出要素がありません</div>
          )}
          {filtered.map(it => {
            const isSelected = selectedId === it.id;
            const isVerified = verified.has(it.id);
            const Icon = iconFor(it.kind);
            const color = colorFor(it.kind);
            const label = labelFor(it.kind);
            let title = '';
            let subtitle = '';
            let x = 0, y = 0, w = 0, h = 0;
            if (it.kind === 'span') {
              title = it.span.text;
              subtitle = `${it.span.font_class} ${it.span.size_pt}pt · ${it.span.writing_direction === 'vertical' ? '縦' : '横'}書き`;
              x = it.span.x_pct; y = it.span.y_pct; w = it.span.w_pct; h = it.span.h_pct;
            } else if (it.kind === 'image') {
              title = `${it.image.width}×${it.image.height}px`;
              subtitle = `xref=${it.image.xref} · ${it.image.mime_type}`;
              x = it.image.x_pct; y = it.image.y_pct; w = it.image.w_pct; h = it.image.h_pct;
            } else if (it.kind === 'block') {
              title = it.block.text_preview || `[${it.block.type}] ${it.block.rows ? `rows=${it.block.rows}` : ''}`;
              subtitle = `type=${it.block.type}${it.block.confidence ? ` conf=${(it.block.confidence * 100).toFixed(0)}%` : ''}`;
              x = it.block.x_pct; y = it.block.y_pct; w = it.block.w_pct; h = it.block.h_pct;
            } else if (it.kind === 'barcode') {
              title = it.barcode.value;
              subtitle = `format=${it.barcode.format}`;
              x = it.barcode.x_pct || 0; y = it.barcode.y_pct || 0; w = it.barcode.w_pct || 0; h = it.barcode.h_pct || 0;
            }
            return (
              <button
                key={it.id}
                onClick={() => onSelect(isSelected ? null : it.id)}
                className="w-full text-left px-3 py-2.5 rounded-lg flex items-start gap-3 mb-1 transition-colors"
                style={{
                  background: isSelected ? 'rgba(99,102,241,0.08)' : 'transparent',
                  border: isSelected ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                }}
              >
                <span
                  className="mt-0.5 shrink-0"
                  onClick={e => { e.stopPropagation(); toggleVerified(it.id); }}
                  title={isVerified ? '確認解除' : '確認済にする'}
                >
                  {isVerified
                    ? <CheckCircle2 size={18} style={{ color: '#10b981' }} />
                    : <Circle size={18} style={{ color: '#cbd5e1' }} />}
                </span>
                <span
                  className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center"
                  style={{ background: `${color}15`, color }}
                >
                  <Icon size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-slate-800 truncate">
                    <span
                      className="text-[9px] font-bold mr-1.5 px-1.5 py-0.5 rounded"
                      style={{ background: `${color}15`, color }}
                    >
                      {label}
                    </span>
                    {title || <span className="text-slate-400">(空)</span>}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 truncate">{subtitle}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    ({x.toFixed(1)}%, {y.toFixed(1)}%) {w.toFixed(1)}×{h.toFixed(1)}%
                  </div>
                </div>
                {it.kind === 'image' && (it.image as ImageInfo).data_b64 && (
                  <img
                    src={`data:${it.image.mime_type};base64,${it.image.data_b64}`}
                    alt=""
                    className="w-10 h-10 object-contain shrink-0 rounded border"
                    style={{ borderColor: '#e5e7eb', background: '#f8fafc' }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t flex items-center justify-between text-[11px] text-slate-500" style={{ borderColor: '#e5e7eb' }}>
          <span>クリックで選択 / 円マークで確認済切替</span>
          <span className="font-mono">{stats.verified} / {stats.total}</span>
        </div>
      </div>
    </div>
  );
};

export default DetectionReview;
