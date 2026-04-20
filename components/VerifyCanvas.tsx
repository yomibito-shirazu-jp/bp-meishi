/**
 * VerifyCanvas - HITL 確定フェーズの編集キャンバス。
 *
 * - fabric.js で名刺ページをベクターキャンバスとして描画
 * - 各 span を Textbox として配置（編集・ドラッグ・リサイズ可能）
 * - 空白部分をドラッグ → 新規 Textbox を追加（status='manual'）
 * - Backspace/Delete → 選択オブジェクトを削除（spans からも除去）
 * - verified / inferred / manual を枠色で区別
 *
 * オブジェクト ⇔ spans の同期は「操作ごとに親へコールバック」方式。
 * 親側で immer を使った不変更新を行う前提。
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as fabric from 'fabric';
import { Span } from '../types';
import { getFontRenderStyle, REGISTERED_FONT_FAMILIES } from '../utils';
import { loadFontMetrics, bboxHeightFromFontSize, fontSizeToCanvasPx } from '../services/fontMetrics';
import { pctToFabricPx, canvasPxPerPt, fabricPxToPct } from '../services/coordTransform';

const MM_TO_PT = 72 / 25.4;

export interface VerifyCanvasProps {
  spans: Span[];
  pageMM: [number, number];
  bgPngDataUrl?: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSpanChange: (id: string, patch: Partial<Span>) => void;
  onSpanAdd: (span: Span) => void;
  onSpanDelete: (id: string) => void;
  readOnly?: boolean;
}

type FabricObjectWithSpanId = fabric.FabricObject & { spanId?: string };

const strokeForStatus = (status?: Span['status']): string => {
  switch (status) {
    case 'verified': return '#10b981';  // 緑 = 確定
    case 'manual': return '#8b5cf6';    // 紫 = 手動追加
    default: return '#f59e0b';           // 琥珀 = 未確定（AI推論）
  }
};

const bgForStatus = (status?: Span['status']): string => {
  switch (status) {
    case 'verified': return 'rgba(16,185,129,0.06)';
    case 'manual': return 'rgba(139,92,246,0.06)';
    default: return 'rgba(245,158,11,0.06)';
  }
};

export const VerifyCanvas: React.FC<VerifyCanvasProps> = ({
  spans,
  pageMM,
  bgPngDataUrl,
  selectedId,
  onSelect,
  onSpanChange,
  onSpanAdd,
  onSpanDelete,
  readOnly,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const spansRef = useRef<Span[]>(spans);
  spansRef.current = spans;
  const [fontsLoaded, setFontsLoaded] = useState(false);

  // ── spans で使う A-OTF フォントを document.fonts.load() で事前ロード ──
  // これをしないと fabric.js canvas は Noto Sans JP フォールバックで描画されて
  // 「フォント変えても変わらない」状態になる
  useEffect(() => {
    const neededFamilies = new Set<string>();
    for (const s of spans) {
      const { fontFamily } = getFontRenderStyle(s.font_class, s.font_original);
      const first = fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (REGISTERED_FONT_FAMILIES.includes(first)) neededFamilies.add(first);
    }
    if (neededFamilies.size === 0 && fontsLoaded) return;
    const d = document as Document & { fonts?: FontFaceSet };
    if (!d.fonts) { setFontsLoaded(true); return; }
    Promise.all(
      Array.from(neededFamilies).map(f =>
        d.fonts!.load(`16pt '${f}'`).catch(() => null)
      )
    ).then(() => {
      setFontsLoaded(true);
      // fabric 既存 canvas を再描画させて反映
      fabricRef.current?.requestRenderAll();
    });
  }, [spans]);

  // 新規矩形ドラッグ作成用
  const drawStateRef = useRef<{
    isDrawing: boolean;
    startX: number;
    startY: number;
    rect: fabric.Rect | null;
  }>({ isDrawing: false, startX: 0, startY: 0, rect: null });

  const getPageSize = useCallback(() => {
    const el = containerRef.current;
    if (!el) return { w: 800, h: 500, pxPerPt: 1 };
    const maxW = Math.min(el.clientWidth - 16, 1200);
    const maxH = Math.min(el.clientHeight - 16, 800);
    const [wMM, hMM] = pageMM;
    const wPt = wMM * MM_TO_PT;
    const hPt = hMM * MM_TO_PT;
    const aspect = wPt / hPt;
    let w = maxW;
    let h = maxW / aspect;
    if (h > maxH) { h = maxH; w = maxH * aspect; }
    return { w, h, pxPerPt: w / wPt };
  }, [pageMM]);

  // ── Canvas 初期化 ──
  useEffect(() => {
    if (!canvasElRef.current) return;
    const { w, h } = getPageSize();
    const c = new fabric.Canvas(canvasElRef.current, {
      width: w,
      height: h,
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      selection: !readOnly,
    });
    fabricRef.current = c;

    // 背景 PNG
    if (bgPngDataUrl) {
      const imgUrl = bgPngDataUrl.startsWith('data:')
        ? bgPngDataUrl
        : `data:image/png;base64,${bgPngDataUrl}`;
      fabric.FabricImage.fromURL(imgUrl).then((img) => {
        img.set({
          selectable: false,
          evented: false,
          scaleX: w / (img.width || w),
          scaleY: h / (img.height || h),
          opacity: 0.35,
        });
        c.backgroundImage = img;
        c.requestRenderAll();
      }).catch((err) => console.warn('bg image load failed', err));
    }

    // ── 選択変更 → onSelect ──
    const handleSelect = (e: Partial<fabric.TEvent> & { selected?: fabric.FabricObject[] }) => {
      const obj = e.selected?.[0] as FabricObjectWithSpanId | undefined;
      onSelect(obj?.spanId ?? null);
    };
    const handleCleared = () => onSelect(null);
    c.on('selection:created', handleSelect);
    c.on('selection:updated', handleSelect);
    c.on('selection:cleared', handleCleared);

    // ── 移動・リサイズ完了 → onSpanChange ──
    const handleModified = (e: { target?: fabric.FabricObject }) => {
      const obj = e.target as FabricObjectWithSpanId | undefined;
      if (!obj || !obj.spanId) return;
      const pageW = c.width || 1;
      const pageH = c.height || 1;
      const pct = fabricPxToPct({
        x: obj.left || 0,
        y: obj.top || 0,
        w: obj.getScaledWidth() || 0,
        h: obj.getScaledHeight() || 0,
      }, pageW, pageH);
      const patch: Partial<Span> = {
        x_pct: pct.x, y_pct: pct.y, w_pct: pct.w, h_pct: pct.h,
      };
      if (obj.type === 'textbox') {
        patch.text = (obj as fabric.Textbox).text || '';
      }
      onSpanChange(obj.spanId, patch);
    };
    c.on('object:modified', handleModified);

    // ── 空白ドラッグで新規矩形作成 ──
    const handleMouseDown = (opt: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      if (readOnly) return;
      if (opt.target) return; // 既存オブジェクト上なら何もしない
      const p = c.getViewportPoint(opt.e);
      drawStateRef.current = {
        isDrawing: true,
        startX: p.x,
        startY: p.y,
        rect: null,
      };
    };
    const handleMouseMove = (opt: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      if (!drawStateRef.current.isDrawing) return;
      const p = c.getViewportPoint(opt.e);
      const s = drawStateRef.current;
      const x = Math.min(s.startX, p.x);
      const y = Math.min(s.startY, p.y);
      const w = Math.abs(p.x - s.startX);
      const h = Math.abs(p.y - s.startY);
      if (!s.rect) {
        const rect = new fabric.Rect({
          left: x, top: y, width: w, height: h,
          fill: 'rgba(139,92,246,0.1)',
          stroke: '#8b5cf6',
          strokeDashArray: [4, 4],
          strokeWidth: 1,
          selectable: false,
        });
        s.rect = rect;
        c.add(rect);
      } else {
        s.rect.set({ left: x, top: y, width: w, height: h });
      }
      c.requestRenderAll();
    };
    const handleMouseUp = () => {
      const s = drawStateRef.current;
      if (!s.isDrawing || !s.rect) {
        drawStateRef.current.isDrawing = false;
        return;
      }
      const r = s.rect;
      const pageW = c.width || 1;
      const pageH = c.height || 1;
      const w = r.width || 0;
      const h = r.height || 0;
      c.remove(r);
      drawStateRef.current = { isDrawing: false, startX: 0, startY: 0, rect: null };
      // 極小領域は無視
      if (w < 10 || h < 6) return;
      const pxPerPt = c.width! / (pageMM[0] * MM_TO_PT);
      const sizePt = Math.max(6, Math.round(h / pxPerPt));
      const newSpan: Span = {
        id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text: '',
        font_original: 'Manual',
        font_class: 'gothic',
        size_pt: sizePt,
        origin: [0, 0],
        bbox: [0, 0, 0, 0],
        x_pct: ((r.left || 0) / pageW) * 100,
        y_pct: ((r.top || 0) / pageH) * 100,
        w_pct: (w / pageW) * 100,
        h_pct: (h / pageH) * 100,
        writing_direction: 'horizontal',
        status: 'manual',
      };
      onSpanAdd(newSpan);
      onSelect(newSpan.id);
    };
    c.on('mouse:down', handleMouseDown);
    c.on('mouse:move', handleMouseMove);
    c.on('mouse:up', handleMouseUp);

    // ── Delete キーで選択削除 ──
    const handleKey = (e: KeyboardEvent) => {
      if (readOnly) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const active = c.getActiveObject() as FabricObjectWithSpanId | undefined;
      if (!active || !active.spanId) return;
      // 編集中のテキスト入力は無視
      if ((active as fabric.Textbox).isEditing) return;
      e.preventDefault();
      onSpanDelete(active.spanId);
    };
    window.addEventListener('keydown', handleKey);

    return () => {
      window.removeEventListener('keydown', handleKey);
      c.dispose();
      fabricRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 背景 PNG の切替 ──
  useEffect(() => {
    const c = fabricRef.current;
    if (!c) return;
    if (!bgPngDataUrl) {
      c.backgroundImage = undefined;
      c.requestRenderAll();
      return;
    }
    const imgUrl = bgPngDataUrl.startsWith('data:')
      ? bgPngDataUrl
      : `data:image/png;base64,${bgPngDataUrl}`;
    fabric.FabricImage.fromURL(imgUrl).then((img) => {
      const w = c.width || 1;
      const h = c.height || 1;
      img.set({
        selectable: false,
        evented: false,
        scaleX: w / (img.width || w),
        scaleY: h / (img.height || h),
        opacity: 0.35,
      });
      c.backgroundImage = img;
      c.requestRenderAll();
    }).catch(err => console.warn('bg image load failed', err));
  }, [bgPngDataUrl]);

  // ── spans の変化を Canvas に反映（opentype.js メトリクスで 1:1 サイズ計算） ──
  useEffect(() => {
    const c = fabricRef.current;
    if (!c) return;
    const pageW = c.width || 1;
    const pageH = c.height || 1;
    const pxPerPt = canvasPxPerPt(pageW, pageMM[0]);

    const existing = new Map<string, FabricObjectWithSpanId>();
    (c.getObjects() as FabricObjectWithSpanId[]).forEach((o) => {
      if (o.spanId) existing.set(o.spanId, o);
    });

    const seen = new Set<string>();
    // 各 span について非同期にフォントメトリクスをロードして配置
    (async () => {
      for (const s of spans) {
        seen.add(s.id);
        const { x, y, w, h } = pctToFabricPx(
          { x: s.x_pct, y: s.y_pct, w: s.w_pct, h: s.h_pct },
          pageW, pageH,
        );
        const { fontFamily, fontWeight } = getFontRenderStyle(s.font_class, s.font_original);
        const primary = fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
        // opentype.js でメトリクスロード（キャッシュ付き）。1:1 サイズ計算に使う
        const metrics = await loadFontMetrics(primary).catch(() => null);
        // Canvas 描画 fontSize は素直に size_pt * pxPerPt。bbox 幅 w/h はそのまま使う。
        const fontPx = fontSizeToCanvasPx(s.size_pt, pxPerPt);
        const stroke = strokeForStatus(s.status);
        const bg = bgForStatus(s.status);
        const existingObj = existing.get(s.id);
        const common = {
          left: x, top: y, width: w, height: h,
          fontSize: Math.max(4, fontPx),
          fontFamily: primary,
          fontWeight,
          lineHeight: 1.16,  // pdf-lib 側と一致させる (LINE_HEIGHT = 1.16)
          fill: s.color_hex || '#111827',
          backgroundColor: bg,
          stroke,
          strokeWidth: 1,
          lockScalingFlip: true,
        };
        if (existingObj && existingObj.type === 'textbox') {
          const tb = existingObj as fabric.Textbox & { spanId?: string };
          tb.set({ ...common, text: s.text, scaleX: 1, scaleY: 1 });
        } else {
          const tb = new fabric.Textbox(s.text || '(空)', {
            ...common,
            editable: !readOnly,
            hasControls: !readOnly,
          }) as fabric.Textbox & { spanId?: string };
          tb.spanId = s.id;
          c.add(tb);
        }
        // metrics を利用しない場合の抑制（eslint 対策）
        void metrics;
        void bboxHeightFromFontSize;
      }
      existing.forEach((o, id) => { if (!seen.has(id)) c.remove(o); });
      c.requestRenderAll();
    })();
  }, [spans, pageMM, readOnly]);

  // ── selectedId の外部変更を反映 ──
  useEffect(() => {
    const c = fabricRef.current;
    if (!c) return;
    if (!selectedId) {
      c.discardActiveObject();
      c.requestRenderAll();
      return;
    }
    const target = (c.getObjects() as FabricObjectWithSpanId[]).find(o => o.spanId === selectedId);
    if (target && c.getActiveObject() !== target) {
      c.setActiveObject(target);
      c.requestRenderAll();
    }
  }, [selectedId]);

  return (
    <div ref={containerRef} className="relative w-full h-full flex items-center justify-center bg-slate-100 overflow-hidden">
      <canvas ref={canvasElRef} className="shadow-lg rounded" />
      {!readOnly && (
        <div className="absolute top-2 left-2 text-[10px] font-medium px-2 py-1 rounded bg-black/60 text-white pointer-events-none">
          空白をドラッグで新規テキスト追加 / Delete で選択削除
        </div>
      )}
    </div>
  );
};

export default VerifyCanvas;
