import { getDefaultFont } from '@pdfme/common';

let cachedFont: any = null;
let availableFonts: string[] = [];

// Fetch the list of available fonts from the backend
export const fetchFontList = async (): Promise<string[]> => {
  if (availableFonts.length > 0) return availableFonts;
  try {
    const res = await fetch('http://127.0.0.1:8000/api/fonts');
    if (res.ok) {
      const data = await res.json();
      availableFonts = data.fonts || [];
    }
  } catch (err) {
    console.error('Failed to fetch font list from backend', err);
  }
  return availableFonts;
};

// Load a specific font dynamically from the backend and add it to pdfme font config
export const loadDynamicFont = async (fontName: string) => {
  if (!cachedFont) {
    cachedFont = getDefaultFont();
    // Default fallback NotoSansJP
    try {
      const res = await fetch('https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp@5.0.18/files/noto-sans-jp-japanese-400-normal.woff');
      if (res.ok) {
        const jpData = await res.arrayBuffer();
        cachedFont = {
          ...cachedFont,
          NotoSansJP: { fallback: true, data: jpData }
        };
        if (cachedFont.Roboto) {
          cachedFont.Roboto.fallback = false;
        }
      }
    } catch (e) {
      console.warn('Fallback NotoSansJP failed to load');
    }
  }

  // If the requested font is already loaded, just return the cached font dict
  if (cachedFont[fontName]) {
    return cachedFont;
  }

  try {
    console.log(`Loading dynamic font: ${fontName}`);
    const res = await fetch(`http://127.0.0.1:8000/fonts/${encodeURIComponent(fontName)}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch font ${fontName}: ${res.statusText}`);
    }
    const fontData = await res.arrayBuffer();
    
    // Add the newly loaded font
    cachedFont = {
      ...cachedFont,
      [fontName]: {
        fallback: false,
        data: fontData
      }
    };
    return cachedFont;
  } catch (err) {
    console.error(`Failed to load font ${fontName}`, err);
    return cachedFont;
  }
};

export const getPdfmeFont = async () => {
  if (!cachedFont) {
    // Just initialize with the fallback font
    await loadDynamicFont('NotoSansJP');
  }
  return cachedFont;
};
