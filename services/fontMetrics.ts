/**
 * fontMetrics - opentype.js でアップロード済フォントのメトリクス (unitsPerEm / ascent / descent)
 * を取得し、Fabric.js キャンバス上の見た目と pdf-lib の物理出力サイズを 1:1 で一致させる。
 *
 * 使い方:
 *   const m = await loadFontMetrics('A-OTF GothicBBBPro-Medium');
 *   const canvasPx = fontSizeToCanvasPx(sizePt, pxPerPt);
 *   const bboxHeightPx = bboxHeightFromFontSize(sizePt, m, pxPerPt);
 *
 * 1pt = 1/72インチ. Canvas は px, PDF は pt. 同じ文字列が同じ見かけサイズになるには:
 *   canvas_font_px = sizePt * pxPerPt
 *   bbox_height_px = canvas_font_px * (ascender - descender) / unitsPerEm
 */

import * as opentype from 'opentype.js';
import { fontFileUrlFor, REGISTERED_FONT_FAMILIES } from '../utils';

export interface FontMetrics {
  family: string;           // CSS family name (e.g. 'A-OTF GothicBBBPro-Medium')
  url: string;              // /fonts/<file>.otf
  unitsPerEm: number;       // OpenType head.unitsPerEm
  ascender: number;         // hhea.ascent
  descender: number;        // hhea.descent (負値)
  emHeight: number;         // ascender - descender (em basis)
  capHeight?: number;       // OS/2.sCapHeight
  xHeight?: number;         // OS/2.sxHeight
}

const cache = new Map<string, Promise<FontMetrics | null>>();

/** フォントを opentype.js で解析してメトリクスを返す（キャッシュ付き） */
export const loadFontMetrics = async (family: string): Promise<FontMetrics | null> => {
  if (!family) return null;
  const existing = cache.get(family);
  if (existing) return existing;
  const p = (async () => {
    try {
      const url = fontFileUrlFor(family);
      const buf = await fetch(url).then(r => r.ok ? r.arrayBuffer() : null);
      if (!buf) return null;
      const font = opentype.parse(buf);
      const unitsPerEm = font.unitsPerEm || 1000;
      const ascender = (font.ascender ?? font.tables?.hhea?.ascender) || unitsPerEm * 0.8;
      const descender = (font.descender ?? font.tables?.hhea?.descender) || unitsPerEm * -0.2;
      const capHeight = font.tables?.os2?.sCapHeight;
      const xHeight = font.tables?.os2?.sxHeight;
      return {
        family,
        url,
        unitsPerEm,
        ascender,
        descender,
        emHeight: ascender - descender,
        capHeight,
        xHeight,
      } as FontMetrics;
    } catch (e) {
      console.warn('[fontMetrics] failed to load', family, e);
      return null;
    }
  })();
  cache.set(family, p);
  return p;
};

/**
 * 1:1 サイズ計算の基本公式
 *   fontSize (pt) が与えられた時の:
 *     - Canvas 描画用 fontSize (px)    = sizePt * pxPerPt
 *     - Textbox 高さ bbox (px)         = (sizePt * pxPerPt) * (ascender - descender) / unitsPerEm
 *
 * pxPerPt = canvasWidthPx / (pageWidthMM * 72 / 25.4)
 */
export const fontSizeToCanvasPx = (sizePt: number, pxPerPt: number): number =>
  sizePt * pxPerPt;

export const bboxHeightFromFontSize = (
  sizePt: number,
  metrics: FontMetrics | null,
  pxPerPt: number,
): number => {
  const fontPx = fontSizeToCanvasPx(sizePt, pxPerPt);
  if (!metrics) return fontPx * 1.2;  // フォールバック
  return fontPx * (metrics.emHeight / metrics.unitsPerEm);
};

/**
 * 逆算: Document AI から返ってきた bbox 高さ (pt) から fontSize (pt) を推定
 *   sizePt ≈ bboxHeightPt * unitsPerEm / emHeight
 */
export const fontSizeFromBboxHeight = (
  bboxHeightPt: number,
  metrics: FontMetrics | null,
): number => {
  if (!metrics) return bboxHeightPt * 0.8;  // 漢字 em 近似
  return bboxHeightPt * metrics.unitsPerEm / metrics.emHeight;
};

/**
 * Document AI の fontStyle.fontFamily（PostScript名 or 表示名）を
 * アップロード済 A-OTF 148種から部分一致で探す。
 * 見つからなければ null → UI で「要フォント確認」フラグを立てるべし。
 */
export const matchUploadedFont = (docaiFontFamily: string | undefined | null): string | null => {
  if (!docaiFontFamily) return null;
  const canon = docaiFontFamily.replace(/[\s_\-]/g, '').toLowerCase();
  // 完全一致 (正規化後)
  for (const f of REGISTERED_FONT_FAMILIES) {
    if (f.replace(/[\s_\-]/g, '').toLowerCase() === canon) return f;
  }
  // 部分一致
  for (const f of REGISTERED_FONT_FAMILIES) {
    const fc = f.replace(/[\s_\-]/g, '').toLowerCase();
    if (fc.includes(canon) || canon.includes(fc)) return f;
  }
  return null;
};
