import { getDefaultFont } from '@pdfme/common';

let cachedFont: any = null;

export const getPdfmeFont = async () => {
  if (cachedFont) return cachedFont;
  try {
    const defaultFont = getDefaultFont();
    // Fetch a Japanese font (woff) that fontkit supports (pdfme uses fontkit)
    const res = await fetch('https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp@5.0.18/files/noto-sans-jp-japanese-400-normal.woff');
    
    if (!res.ok) {
      throw new Error(`Failed to fetch font: ${res.statusText}`);
    }
    
    const jpData = await res.arrayBuffer();
    
    const jpFont = {
      ...defaultFont,
      NotoSansJP: {
        fallback: true,
        data: jpData
      }
    };
    if (jpFont.Roboto) {
        jpFont.Roboto.fallback = false;
    }
    cachedFont = jpFont;
    return cachedFont;
  } catch (err) {
    console.error('Failed to load Japanese font', err);
    return getDefaultFont();
  }
};
