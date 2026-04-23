import { Span, CardProject } from './types';

export interface FontRenderStyle {
  fontFamily: string;
  fontWeight: number;
}

// Document AI から返る font_family 文字列を @font-face 登録済みCSS名に正規化
// 例: "A-OTF Gothic MB101 Pro B", "A-OTFGothicMB101Pro-Bold" 等のゆらぎを吸収
// @font-face 登録済みのフォント一覧（index.css と 1:1 で対応）
// CSS名(スペース含む) ↔ ファイル名(ハイフン置換 + .otf) の変換規則:
//   'A-OTF FutoGoB101Pr5-Bold' → '/fonts/A-OTF-FutoGoB101Pr5-Bold.otf'
export const REGISTERED_FONT_FAMILIES: string[] = [
  'A-OTF FutoGoB101Pr5-Bold','A-OTF FutoGoB101Pr6-Bold','A-OTF FutoGoB101Pro-Bold','A-OTF FutoMinA101Pro-Bold',
  'A-OTF GotMB101Std-Lig-KS','A-OTF GotMB101Std-Med-KS','A-OTF GotMB101Std-Reg-KS',
  'A-OTF GothicBBBPr6-Medium','A-OTF GothicBBBPr6N-Medium','A-OTF GothicBBBPro-Medium',
  'A-OTF GothicMB101Pr6-Bold','A-OTF GothicMB101Pr6-DeBold','A-OTF GothicMB101Pr6-Heavy','A-OTF GothicMB101Pr6-Light','A-OTF GothicMB101Pr6-Medium','A-OTF GothicMB101Pr6-Reg','A-OTF GothicMB101Pr6-Ultra',
  'A-OTF GothicMB101Pro-Bold','A-OTF GothicMB101Pro-DeBold','A-OTF GothicMB101Pro-Heavy','A-OTF GothicMB101Pro-Light','A-OTF GothicMB101Pro-Medium','A-OTF GothicMB101Pro-Reg','A-OTF GothicMB101Pro-Ultra',
  'A-OTF Jun101Pro-Light','A-OTF Jun201Pro-Regular','A-OTF Jun34Pro-Medium','A-OTF Jun501Pro-Bold',
  'A-OTF MiGoMB1Std-DeBold','A-OTF MidashiGoPr5-MB31','A-OTF MidashiGoPr6-MB31','A-OTF MidashiGoPr6N-MB31','A-OTF MidashiGoPro-MB31',
  'A-OTF RyuminPr6-Bold','A-OTF RyuminPr6-ExBold','A-OTF RyuminPr6-ExHeavy','A-OTF RyuminPr6-Heavy','A-OTF RyuminPr6-Light','A-OTF RyuminPr6-Medium','A-OTF RyuminPr6-Regular','A-OTF RyuminPr6-Ultra',
  'A-OTF RyuminPro-Bold','A-OTF RyuminPro-ExBold','A-OTF RyuminPro-ExHeavy','A-OTF RyuminPro-Heavy','A-OTF RyuminPro-Light','A-OTF RyuminPro-Medium','A-OTF RyuminPro-Regular','A-OTF RyuminPro-Ultra',
  'A-OTF RyuminStd-Bold-KO','A-OTF RyuminStd-Bold-KS','A-OTF RyuminStd-ExBold-KO','A-OTF RyuminStd-ExBold-KS','A-OTF RyuminStd-ExHeavy-KO','A-OTF RyuminStd-ExHeavy-KS','A-OTF RyuminStd-Heavy-KO','A-OTF RyuminStd-Heavy-KS','A-OTF RyuminStd-Light-KO','A-OTF RyuminStd-Light-KS','A-OTF RyuminStd-Medium-KO','A-OTF RyuminStd-Medium-KS','A-OTF RyuminStd-Regular-KO','A-OTF RyuminStd-Regular-KS','A-OTF RyuminStd-Ultra-KO','A-OTF RyuminStd-Ultra-KS',
  'A-OTF SeiKaiCB1Pr5-Regular','A-OTF SeiKaiCB1Std-Regular',
  'A-OTF ShinGoMin-Emboss','A-OTF ShinGoMin-Futoline','A-OTF ShinGoMin-Line','A-OTF ShinGoMin-Shadow',
  'A-OTF ShinGoPr6-Bold','A-OTF ShinGoPr6-DeBold','A-OTF ShinGoPr6-ExLight','A-OTF ShinGoPr6-Heavy','A-OTF ShinGoPr6-Light','A-OTF ShinGoPr6-Medium','A-OTF ShinGoPr6-Regular','A-OTF ShinGoPr6-Ultra',
  'A-OTF ShinGoPro-Bold','A-OTF ShinGoPro-DeBold','A-OTF ShinGoPro-ExLight','A-OTF ShinGoPro-Heavy','A-OTF ShinGoPro-Light','A-OTF ShinGoPro-Medium','A-OTF ShinGoPro-Regular','A-OTF ShinGoPro-Ultra',
  'A-OTF ShinMGoMin-Emboss','A-OTF ShinMGoMin-Futoline','A-OTF ShinMGoMin-Line','A-OTF ShinMGoMin-Shadow',
  'A-OTF ShinMGoPr6-Bold','A-OTF ShinMGoPr6-DeBold','A-OTF ShinMGoPr6-Heavy','A-OTF ShinMGoPr6-Light','A-OTF ShinMGoPr6-Medium','A-OTF ShinMGoPr6-Regular','A-OTF ShinMGoPr6-Ultra',
  'A-OTF ShinMGoPro-Bold','A-OTF ShinMGoPro-DeBold','A-OTF ShinMGoPro-Heavy','A-OTF ShinMGoPro-Light','A-OTF ShinMGoPro-Medium','A-OTF ShinMGoPro-Regular','A-OTF ShinMGoPro-Ultra',
  'A-OTF ShinseiKaiPro-CBSK1',
  'A-OTF UDShinGoPr6-Bold','A-OTF UDShinGoPr6-DeBold','A-OTF UDShinGoPr6-Heavy','A-OTF UDShinGoPr6-Light','A-OTF UDShinGoPr6-Medium','A-OTF UDShinGoPr6-Regular',
  'A-OTF UDShinGoPro-Bold','A-OTF UDShinGoPro-DeBold','A-OTF UDShinGoPro-Heavy','A-OTF UDShinGoPro-Light','A-OTF UDShinGoPro-Medium','A-OTF UDShinGoPro-Regular',
  'A-OTF UDShinMGoPr6-Bold','A-OTF UDShinMGoPr6-DeBold','A-OTF UDShinMGoPr6-Heavy','A-OTF UDShinMGoPr6-Light','A-OTF UDShinMGoPr6-Medium','A-OTF UDShinMGoPr6-Regular',
  'A-OTF UDShinMGoPro-Bold','A-OTF UDShinMGoPro-DeBold','A-OTF UDShinMGoPro-Heavy','A-OTF UDShinMGoPro-Light','A-OTF UDShinMGoPro-Medium','A-OTF UDShinMGoPro-Regular',
  'AGaramondPro-Bold','AGaramondPro-BoldItalic','AGaramondPro-Italic','AGaramondPro-Regular','AGaramondPro-Semibold','AGaramondPro-SemiboldItalic',
  'Century Old Style Italic','Helvetica LT Std Bold Fractions','Helvetica LT Std Fractions',
  'century-old-style-std','century-old-style-std-bold','century-old-style-std-italic',
  'helvetica-black','helvetica-bold','helvetica-demi-bold','helvetica-inserat-roman','helvetica-italic','helvetica-lt-std-bold',
];

// CSS名 → /fonts/<file>.otf のURL
export const fontFileUrlFor = (cssName: string, origin?: string): string => {
  const fname = cssName.replace(/\s+/g, '-') + '.otf';
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/fonts/${fname}`;
};

// 全フォント分の @font-face 規則を生成（iframe 印刷用に親CSSを継承できない場合に使用）
export const buildAllFontFaceCss = (origin?: string): string => {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return REGISTERED_FONT_FAMILIES.map(name => {
    const file = name.replace(/\s+/g, '-') + '.otf';
    const fmt = 'opentype';
    return `@font-face{font-family:'${name}';src:url('${base}/fonts/${file}') format('${fmt}');font-display:block;}`;
  }).join('\n');
};

const normalizeMorisawaName = (src: string): string | null => {
  if (!src) return null;
  // 入力の前処理:
  //  - PDF サブセット接頭辞 'ABCDEF+' を除去
  //  - 小文字化+ノイズ除去(空白・ハイフン・アンダースコア・プラス)で一致検索
  const stripped = src.replace(/^[A-Z]{6}\+/, '');
  const canonize = (s: string) => s.replace(/[\s_\-+]/g, '').toLowerCase();
  const canon = canonize(stripped);
  if (!canon) return null;

  const registry: Record<string, string> = {};
  REGISTERED_FONT_FAMILIES.forEach(name => {
    registry[canonize(name)] = name;
  });

  // 1) 完全一致
  if (registry[canon]) return registry[canon];

  // 2) 部分一致: 入力が登録名を含む / 登録名が入力を含む
  //    登録名が長い順に評価して最長マッチを優先
  const keys = Object.keys(registry).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (canon.includes(key) || key.includes(canon)) return registry[key];
  }
  return null;
};

// font_class + font_original から最適な font-family スタックを決定
export const getFontRenderStyle = (
  fontClass: Span['font_class'] | 'markdown_body' | 'markdown_heading' = 'gothic',
  fontOriginal?: string,
): FontRenderStyle => {
  // 1) font_original が Document AI から与えられていれば、それを優先して探索
  const exact = fontOriginal ? normalizeMorisawaName(fontOriginal) : null;
  if (exact) {
    const isMincho = /mincho|ryumin|serif|min\b/i.test(exact);
    return {
      fontFamily: `'${exact}', 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', ${isMincho ? 'serif' : 'sans-serif'}`,
      fontWeight: 500,
    };
  }

  // 2) フォールバック: font_class ベース(4分類)
  if (fontClass === 'mincho' || fontClass === 'markdown_heading') {
    return {
      fontFamily: "'A-OTF RyuminPro-Medium', 'A-OTF RyuminPro-Regular', 'A-OTF RyuminPr6-Medium', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho', serif",
      fontWeight: 500,
    };
  }

  if (fontClass === 'light') {
    return {
      fontFamily: "'A-OTF ShinGoPro-Light', 'A-OTF ShinGoPro-ExLight', 'A-OTF Jun101Pro-Light', 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
      fontWeight: 300,
    };
  }

  if (fontClass === 'gothic_bold') {
    return {
      fontFamily: "'A-OTF GothicMB101Pro-Bold', 'A-OTF GothicMB101Pro-Heavy', 'A-OTF ShinGoPro-Bold', 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
      fontWeight: 700,
    };
  }

  return {
    fontFamily: "'A-OTF GothicBBBPro-Medium', 'A-OTF GothicMB101Pro-Medium', 'A-OTF ShinGoPro-Medium', 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif",
    fontWeight: 500,
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

// ── HTML カードレンダラ（プレビュー＝印刷PDFの単一ソース） ───────────
// spans と pageMM と背景PNG から、A) 画面プレビュー用, B) window.print() 用
// のHTML全体を生成する。preview / print で完全に同じ位置・フォント・書字方向を再現。

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface RenderCardOptions {
  spans: Span[];
  pageMM: [number, number];
  bgPngDataUrl?: string | null;      // 元PNGを背景に敷く(data URL含む)
  coverOriginals?: boolean;          // true で全スパン位置に白矩形を敷き、元PNG文字を完全被覆
  title?: string;
}

export const buildCardHtml = (opt: RenderCardOptions): string => {
  const { spans, pageMM, bgPngDataUrl, coverOriginals = true, title = '名刺' } = opt;
  const [wMM, hMM] = pageMM;

  // iframe では親CSSを継承しないので、@font-face を直接埋め込む
  const fontFaceCss = buildAllFontFaceCss();

  const bgCss = bgPngDataUrl
    ? `background-image: url('${bgPngDataUrl}'); background-size: 100% 100%; background-repeat: no-repeat; background-position: top left;`
    : 'background: #ffffff;';

  const elements = spans.map(s => {
    const isVertical = s.writing_direction === 'vertical';
    const { fontFamily, fontWeight } = getFontRenderStyle(s.font_class, s.font_original);
    const writingMode = isVertical ? 'vertical-rl' : 'horizontal-tb';
    const textOrientation = isVertical ? 'upright' : 'mixed';
    const color = (s as unknown as { color_hex?: string }).color_hex || '#111111';
    const cover = coverOriginals ? 'background: #ffffff;' : '';
    const align = isVertical ? 'center' : 'flex-start';
    const pad = isVertical ? '2px 0' : '0 2px';
    const ws = isVertical ? 'normal' : 'nowrap';
    return (
      `<div class="sp" style="left:${s.x_pct}%;top:${s.y_pct}%;width:${s.w_pct}%;height:${s.h_pct}%;`
      + `font-family:${fontFamily};font-weight:${fontWeight};font-size:${s.size_pt}pt;`
      + `writing-mode:${writingMode};text-orientation:${textOrientation};`
      + `color:${color};white-space:${ws};justify-content:${align};padding:${pad};${cover}">`
      + `<span>${escapeHtml(s.text)}</span></div>`
    );
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
${fontFaceCss}
@page { size: ${wMM}mm ${hMM}mm; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${wMM}mm; height: ${hMM}mm; }
body {
  position: relative;
  overflow: hidden;
  ${bgCss}
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  color-adjust: exact;
  font-family: 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif;
}
.sp {
  position: absolute;
  display: flex;
  align-items: center;
  overflow: hidden;
  line-height: 1.1;
  letter-spacing: 0;
}
@media print {
  body { margin: 0; }
}
</style>
</head>
<body>
${elements}
</body>
</html>`;
};

// iframe を hidden で生成→HTML注入→印刷ダイアログ起動（ユーザーは "PDFに保存"）
export const printCardAsPdf = async (opt: RenderCardOptions): Promise<void> => {
  const html = buildCardHtml(opt);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);

  // 使用されるフォントファミリーを抽出（スペース区切りで最初の候補のみ、@font-face登録済のもの）
  const usedFamilies = new Set<string>();
  for (const s of opt.spans) {
    const { fontFamily } = getFontRenderStyle(s.font_class, s.font_original);
    // 'A-OTF Ryumin...', 'Noto...' → 最初の候補を抽出
    const first = fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (REGISTERED_FONT_FAMILIES.includes(first)) usedFamilies.add(first);
  }

  await new Promise<void>((resolve) => {
    const doc = iframe.contentDocument;
    if (!doc) { resolve(); return; }
    doc.open();
    doc.write(html);
    doc.close();
    const start = async () => {
      const win = iframe.contentWindow;
      if (!win) { resolve(); return; }
      // 使用フォントを明示的にロードしてからprint（font-display:block でも確実に待つ）
      try {
        const docFonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
        if (docFonts) {
          await Promise.all(
            Array.from(usedFamilies).map(f =>
              docFonts.load(`12pt '${f}'`).catch(() => null),
            ),
          );
          await docFonts.ready;
        }
      } catch { /* noop */ }
      // 背景画像ロード（body の background-image を先読み）
      if (opt.bgPngDataUrl) {
        await new Promise<void>(r => {
          const img = doc.createElement('img');
          img.onload = () => r();
          img.onerror = () => r();
          img.src = opt.bgPngDataUrl!;
          setTimeout(() => r(), 800);
        });
      }
      setTimeout(() => {
        try { win.focus(); win.print(); } catch { /* noop */ }
        // 印刷ダイアログ閉じた後に撤去
        setTimeout(() => { iframe.remove(); resolve(); }, 1500);
      }, 150);
    };
    if (doc.readyState === 'complete') start();
    else iframe.addEventListener('load', start, { once: true });
  });
};
