/**
 * coordTransform - 3 段階の座標変換を 1 ヶ所に集約。
 *
 *   Document AI (normalizedVertices 0.0-1.0, 左上原点)
 *     ↓
 *   Fabric.js キャンバス (px, 左上原点)
 *     ↓
 *   pdf-lib (pt, 左下原点)
 *
 * 1pt = 1/72 inch = 25.4/72 mm ≈ 0.3528 mm
 */

const MM_TO_PT = 72 / 25.4;

export interface PageSize {
  widthMM: number;
  heightMM: number;
}

export interface Rect { x: number; y: number; w: number; h: number; }

/** mm → pt */
export const mmToPt = (mm: number) => mm * MM_TO_PT;
/** pt → mm */
export const ptToMm = (pt: number) => pt / MM_TO_PT;

/**
 * Document AI の normalizedVertices (0-1) から矩形を取り出す
 * 返り値: pct (0-100) ベースの左上原点矩形
 */
export const normalizedVerticesToPct = (
  vertices: { x: number; y: number }[],
): Rect | null => {
  if (!vertices || vertices.length < 4) return null;
  const xs = vertices.map(v => v.x);
  const ys = vertices.map(v => v.y);
  const xMin = Math.min(...xs);
  const yMin = Math.min(...ys);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  return {
    x: xMin * 100,
    y: yMin * 100,
    w: (xMax - xMin) * 100,
    h: (yMax - yMin) * 100,
  };
};

/**
 * pct 座標 (左上原点、0-100) → Fabric Canvas 座標 (px、左上原点)
 */
export const pctToFabricPx = (
  rect: Rect,
  canvasWidthPx: number,
  canvasHeightPx: number,
): Rect => ({
  x: (rect.x / 100) * canvasWidthPx,
  y: (rect.y / 100) * canvasHeightPx,
  w: (rect.w / 100) * canvasWidthPx,
  h: (rect.h / 100) * canvasHeightPx,
});

/**
 * pct 座標 (左上原点、0-100) → pdf-lib 座標 (pt、左下原点)
 * pdf-lib の drawText / drawRectangle の x,y は「左下」を指す。
 *   pdfX = pct.x/100 * pageWidthPt
 *   pdfY = pageHeightPt - (pct.y + pct.h)/100 * pageHeightPt
 *
 * height は反転不要（そのまま pt 換算）。
 */
export const pctToPdfPt = (
  rect: Rect,
  pageWidthMM: number,
  pageHeightMM: number,
): Rect => {
  const pageWPt = pageWidthMM * MM_TO_PT;
  const pageHPt = pageHeightMM * MM_TO_PT;
  const xPt = (rect.x / 100) * pageWPt;
  const wPt = (rect.w / 100) * pageWPt;
  const hPt = (rect.h / 100) * pageHPt;
  // 左上原点 y_top を左下原点 y_bottom に変換:
  //   y_bottom = pageHPt - (y_top + h)
  const yPt = pageHPt - ((rect.y / 100) * pageHPt + hPt);
  return { x: xPt, y: yPt, w: wPt, h: hPt };
};

/**
 * Fabric Canvas 座標 (px、左上) → pct (0-100)
 * Fabric から D&D で移動した結果を span に戻す時に使う
 */
export const fabricPxToPct = (
  px: Rect,
  canvasWidthPx: number,
  canvasHeightPx: number,
): Rect => ({
  x: (px.x / canvasWidthPx) * 100,
  y: (px.y / canvasHeightPx) * 100,
  w: (px.w / canvasWidthPx) * 100,
  h: (px.h / canvasHeightPx) * 100,
});

/**
 * Canvas の 1ptあたりpx. フォントサイズ計算に使う.
 *   pxPerPt = canvasWidthPx / (pageWidthMM * MM_TO_PT)
 */
export const canvasPxPerPt = (
  canvasWidthPx: number,
  pageWidthMM: number,
): number => canvasWidthPx / (pageWidthMM * MM_TO_PT);

/**
 * Document AI の layout.boundingPoly.normalizedVertices から
 * 物理サイズ (pt) の bbox 高さを得る.
 *   heightPt = normalizedHeight * pageHeightMM * MM_TO_PT
 */
export const docaiBboxHeightPt = (
  vertices: { x: number; y: number }[],
  pageHeightMM: number,
): number => {
  const rect = normalizedVerticesToPct(vertices);
  if (!rect) return 0;
  return (rect.h / 100) * pageHeightMM * MM_TO_PT;
};
