import { Span, CardProject } from './types';

export interface FontRenderStyle {
  fontFamily: string;
  fontWeight: number;
}

export const getFontRenderStyle = (
  fontClass: Span['font_class'] | 'markdown_body' | 'markdown_heading' = 'gothic',
): FontRenderStyle => {
  if (fontClass === 'mincho' || fontClass === 'markdown_heading') {
    return {
      fontFamily: "'Noto Serif JP', 'Hiragino Mincho ProN', serif",
      fontWeight: 400,
    };
  }

  if (fontClass === 'light') {
    return {
      fontFamily: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
      fontWeight: 300,
    };
  }

  if (fontClass === 'gothic_bold') {
    return {
      fontFamily: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
      fontWeight: 700,
    };
  }

  return {
    fontFamily: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
    fontWeight: 400,
  };
};

export const getCompanyName = (spans: Span[]): string => {
  if (!spans || spans.length === 0) return '未分類';
  const gothic = spans.filter(s => s.font_class === 'gothic' || s.font_class === 'gothic_bold');
  if (gothic.length > 0) {
    return [...gothic].sort((a, b) => b.size_pt - a.size_pt)[0].text.trim() || '未分類';
  }
  const nonMincho = spans.filter(s => s.font_class !== 'mincho');
  return nonMincho.length > 0 ? nonMincho[0].text.trim() || '未分類' : '未分類';
};

export const isUnprocessed = (p: CardProject): boolean => {
  if (!p.original_spans || !p.spans || p.original_spans.length === 0) return true;
  return p.spans.every((s, i) => p.original_spans[i] && s.text === p.original_spans[i].text);
};
