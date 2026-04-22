/**
 * 和文 DTP 再現用のテキストフィッター。
 *
 * bbox の自然幅と実際の描画サイズを比較して 3 つの挙動に切り替える:
 *
 *  1. 自然幅 > bbox: `scaleX` (または縦書きでは `scaleY`) で縮める
 *  2. 自然幅 << bbox: 「阿部　翼」のように元々広いカーニングで組まれてる名前
 *     → `letter-spacing` を均等に広げて bbox を埋める
 *     (スペースがあれば `text-align-last: justify` で空白だけ伸ばす = より忠実)
 *  3. ほぼ同じ: そのまま
 *
 * palt / kern / font-kerning は常時有効で欧文・和文混植の不自然な空きを詰める。
 */
import React, { useLayoutEffect, useRef } from 'react';

export interface AutoFitTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  textOrientation?: 'mixed' | 'upright';
  /**
   * scaleX の下限。これ以下にはしない。
   * 名刺 DTP だと 0.7 くらいまでは崩れず読める。
   */
  minScale?: number;
  /**
   * 自然幅がこの割合より小さいとき、letter-spacing で埋める。
   * 0.85 = 自然幅が bbox の 85% 未満なら拡張対象。
   */
  spreadThreshold?: number;
}

const hasExpandableSpace = (s: React.ReactNode): boolean => {
  if (typeof s === 'string') return / |\u3000/.test(s);
  if (Array.isArray(s)) return s.some(hasExpandableSpace);
  return false;
};

const textLength = (s: React.ReactNode): number => {
  if (typeof s === 'string') return Array.from(s).length;
  if (Array.isArray(s)) return s.reduce<number>((a, b) => a + textLength(b), 0);
  return 0;
};

export const AutoFitText: React.FC<AutoFitTextProps> = ({
  children,
  writingMode = 'horizontal-tb',
  textOrientation = 'mixed',
  minScale = 0.65,
  spreadThreshold = 0.85,
  style,
  ...rest
}) => {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const isVertical = writingMode === 'vertical-rl';

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      // 一旦すべてのフィット系スタイルをリセットして自然サイズを測る
      inner.style.transform = 'none';
      inner.style.letterSpacing = '0';
      inner.style.textAlign = 'left';
      inner.style.textAlignLast = 'auto';
      inner.style.width = 'auto';

      const outerRect = outer.getBoundingClientRect();
      const natural = isVertical ? inner.scrollHeight : inner.scrollWidth;
      const avail = isVertical ? outerRect.height : outerRect.width;
      if (natural <= 0 || avail <= 0) return;

      if (natural > avail) {
        // (1) はみ出し → scaleX/scaleY で縮める
        const s = Math.max(minScale, avail / natural);
        inner.style.transform = isVertical ? `scaleY(${s})` : `scaleX(${s})`;
        return;
      }

      if (natural < avail * spreadThreshold) {
        // (2) 元より狭い → 文字間を広げて埋める
        const extra = avail - natural; // px
        const len = textLength(children);
        // 幅いっぱい (= 100%) に広げて letter-spacing を均等配分
        inner.style.width = `${avail}px`;
        if (hasExpandableSpace(children) && !isVertical) {
          // スペースを持つテキストは word-space 方式: 空白だけ伸ばす
          inner.style.textAlign = 'justify';
          inner.style.textAlignLast = 'justify';
        } else if (len > 1) {
          // 文字間均等配分
          const gap = extra / (len - 1);
          if (isVertical) {
            // 縦書きは line-height で調整 (letter-spacing は縦では効きにくいブラウザあり)
            (inner.style as CSSStyleDeclaration & { lineHeight: string }).lineHeight =
              `${1 + gap / parseFloat(getComputedStyle(inner).fontSize || '12')}`;
          } else {
            inner.style.letterSpacing = `${gap}px`;
          }
        }
        return;
      }

      // (3) ほぼ合致: デフォルトのまま
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    const d = document as Document & { fonts?: FontFaceSet };
    const fontsReady = d.fonts?.ready;
    if (fontsReady) {
      fontsReady.then(measure).catch(() => undefined);
    }
    return () => {
      ro.disconnect();
    };
  }, [children, isVertical, minScale, spreadThreshold]);

  // Japanese DTP kerning を常時有効
  const kerningStyle: React.CSSProperties = {
    fontFeatureSettings: '"palt" 1, "kern" 1, "pkna" 1',
    fontKerning: 'normal',
    writingMode,
    textOrientation,
  };

  return (
    <span
      ref={outerRef}
      style={{
        display: 'inline-block',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        ...kerningStyle,
        ...style,
      }}
      {...rest}
    >
      <span
        ref={innerRef}
        style={{
          display: 'inline-block',
          transformOrigin: isVertical ? 'center top' : 'left center',
          whiteSpace: isVertical ? 'normal' : 'nowrap',
        }}
      >
        {children}
      </span>
    </span>
  );
};

export default AutoFitText;
