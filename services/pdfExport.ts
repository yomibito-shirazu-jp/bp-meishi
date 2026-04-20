/**
 * Client-side PDF generator for business cards.
 *
 * Single source of truth for "edit → pick font → save → PDF":
 *   - No PyMuPDF / no server-side font embedding / no coordinate translation
 *   - Embeds the fonts users actually picked in the editor (OTF/TTF from /fonts)
 *   - Positions text using the same x_pct/y_pct/w_pct/h_pct the preview uses
 *
 * Output: Uint8Array of a standalone PDF at the exact page_mm size.
 */

import { PDFDocument, PDFFont, PDFImage, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Span } from '../types';
import { REGISTERED_FONT_FAMILIES, fontFileUrlFor } from '../utils';
import { pctToPdfPt } from './coordTransform';
import { loadFontMetrics } from './fontMetrics';

const MM_TO_PT = 72 / 25.4;

// CSS フォントスタック "'A-OTF Ryumin...', 'Noto...', serif" の先頭候補を取る
const pickPrimaryFamily = (stack: string): string | null => {
  const first = stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return first || null;
};

// Span の font_class / font_original から使用する A-OTF ファミリー名を決定
// 既存の utils.getFontRenderStyle と同じ優先ルール
const resolveFamilyFromSpan = (s: Span): string | null => {
  // font_original が直接 REGISTERED に含まれる場合はそれを使う
  if (s.font_original) {
    const canon = s.font_original.replace(/[\s_\-]/g, '').toLowerCase();
    const hit = REGISTERED_FONT_FAMILIES.find(
      n => n.replace(/[\s_\-]/g, '').toLowerCase() === canon,
    );
    if (hit) return hit;
  }
  // font_class ベースの既定
  switch (s.font_class) {
    case 'mincho': return 'A-OTF RyuminPro-Medium';
    case 'light': return 'A-OTF ShinGoPro-Light';
    case 'gothic_bold': return 'A-OTF GothicMB101Pro-Bold';
    case 'gothic':
    default: return 'A-OTF GothicBBBPro-Medium';
  }
};

const hexToRgb = (hex?: string): [number, number, number] => {
  if (!hex) return [0, 0, 0];
  const h = hex.replace('#', '');
  const v = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return [v[0] / 255, v[1] / 255, v[2] / 255];
};

// fetch OTF bytes from /fonts/<file>.otf once and cache
const fontBytesCache = new Map<string, Uint8Array>();
const loadFontBytes = async (family: string): Promise<Uint8Array | null> => {
  if (fontBytesCache.has(family)) return fontBytesCache.get(family)!;
  try {
    const res = await fetch(fontFileUrlFor(family));
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    fontBytesCache.set(family, buf);
    return buf;
  } catch {
    return null;
  }
};

// data-url or base64 PNG → bytes
const pngToBytes = (src: string): Uint8Array => {
  const base64 = src.includes(',') ? src.split(',', 2)[1] : src;
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export interface ExportPdfOptions {
  spans: Span[];
  pageMM: [number, number];
  bgPngBase64?: string | null;   // 元PDFの背景(オリジナル PNG)
  coverOriginals?: boolean;      // 元PDF上のテキストを白ボックスで被覆
  title?: string;
  /**
   * 出力対象の span を status で絞り込み。
   * - 'verified' : status='verified' または 'manual' のみ（HITL確定データだけ出力）
   * - 'all'      : すべて（デフォルト。status指定なしの旧データも含む）
   */
  statusFilter?: 'verified' | 'all';
}

export const exportCardAsPdfBytes = async (opt: ExportPdfOptions): Promise<Uint8Array> => {
  const { pageMM, bgPngBase64, coverOriginals = true, title, statusFilter = 'all' } = opt;
  // ── status フィルタ: HITL確定モードでは verified/manual のみ出力 ──
  const spans = statusFilter === 'verified'
    ? opt.spans.filter(s => s.status === 'verified' || s.status === 'manual')
    : opt.spans;
  const [wMM, hMM] = pageMM;
  const pageW = wMM * MM_TO_PT;
  const pageH = hMM * MM_TO_PT;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  if (title) pdfDoc.setTitle(title);
  pdfDoc.setProducer('bp-meishi (pdf-lib)');
  pdfDoc.setCreationDate(new Date());

  const page = pdfDoc.addPage([pageW, pageH]);

  // 背景 PNG を敷く
  let bgImage: PDFImage | null = null;
  if (bgPngBase64) {
    try {
      bgImage = await pdfDoc.embedPng(pngToBytes(bgPngBase64));
      page.drawImage(bgImage, { x: 0, y: 0, width: pageW, height: pageH });
    } catch (err) {
      console.warn('[pdfExport] bg png embed failed', err);
    }
  }

  // 必要フォントを事前にロード・埋め込み
  const families = new Set<string>();
  for (const s of spans) {
    const f = resolveFamilyFromSpan(s);
    if (f) families.add(f);
  }
  const fontMap = new Map<string, PDFFont>();
  for (const fam of families) {
    const bytes = await loadFontBytes(fam);
    if (!bytes) { console.warn('[pdfExport] font missing', fam); continue; }
    try {
      const embedded = await pdfDoc.embedFont(bytes, { subset: true });
      fontMap.set(fam, embedded);
    } catch (err) {
      console.warn('[pdfExport] embedFont failed', fam, err);
    }
  }
  // Fallback: Standard Helvetica (英数専用)
  const fallbackFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ① 丸め誤差対策: 白塗りは 0.5pt 外側に膨らませて端をカバー（1px未満のハミ出しを防ぐ）
  //    pdf-lib / fontkit の浮動小数点計算で bbox と drawText が sub-pixel ずれるのを吸収
  const COVER_PAD_PT = 0.5;
  if (coverOriginals && bgImage) {
    for (const s of spans) {
      const r = pctToPdfPt(
        { x: s.x_pct, y: s.y_pct, w: s.w_pct, h: s.h_pct },
        wMM, hMM,
      );
      page.drawRectangle({
        x: r.x - COVER_PAD_PT,
        y: r.y - COVER_PAD_PT,
        width: r.w + COVER_PAD_PT * 2,
        height: r.h + COVER_PAD_PT * 2,
        color: rgb(1, 1, 1),
      });
    }
  }

  // 2) 編集済みテキストを描画（opentype.js メトリクスでベースライン正確に）
  for (const s of spans) {
    if (!s.text) continue;
    const r = pctToPdfPt(
      { x: s.x_pct, y: s.y_pct, w: s.w_pct, h: s.h_pct },
      wMM, hMM,
    );
    const family = resolveFamilyFromSpan(s);
    const font = (family && fontMap.get(family)) || fallbackFont;
    const size = s.size_pt || 10;
    const [cr, cg, cb] = hexToRgb(s.color_hex);
    const isVertical = s.writing_direction === 'vertical';

    // opentype.js メトリクスでベースラインオフセットを正確に計算
    const metrics = family ? await loadFontMetrics(family).catch(() => null) : null;
    // descender は負値。ベースラインは bbox 下端から |descender/unitsPerEm * size| 上
    const descRatio = metrics ? Math.abs(metrics.descender) / metrics.unitsPerEm : 0.2;
    const baselineOffset = size * descRatio;

    // ② LineHeight: Fabric Textbox (lineHeight=1.16 既定) と揃えるため、
    //    multi-line 時は size * 1.16 の pitch で順次描画する
    const LINE_HEIGHT = 1.16;

    if (isVertical) {
      const chars = Array.from(s.text);
      const charStep = size * 1.0;
      const cx = r.x + r.w / 2;
      let cy = r.y + r.h - size;
      for (const ch of chars) {
        if (ch === '\n') { cy -= charStep; continue; }
        const chW = (font as PDFFont).widthOfTextAtSize(ch, size);
        page.drawText(ch, {
          x: cx - chW / 2,
          y: cy,
          size,
          font,
          color: rgb(cr, cg, cb),
        });
        cy -= charStep;
      }
    } else {
      // 複数行対応: 改行で分割、各行を lineHeight pitch で下へ
      const lines = s.text.split(/\r?\n/);
      let ly = r.y + r.h - size + baselineOffset;  // 最上段ベースライン
      const pitchPt = size * LINE_HEIGHT;
      for (const line of lines) {
        if (line.length > 0) {
          page.drawText(line, {
            x: r.x,
            y: ly,
            size,
            font,
            color: rgb(cr, cg, cb),
          });
        }
        ly -= pitchPt;
      }
    }
  }

  return pdfDoc.save();
};

export const downloadPdfBytes = (bytes: Uint8Array, filename: string): void => {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
