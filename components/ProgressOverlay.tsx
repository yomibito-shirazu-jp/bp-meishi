import { useEffect, useRef, useState } from 'react';

/**
 * 汎用プログレスオーバーレイ（残り時間推定つき）。
 *
 * バックエンドがストリーミング進捗を返さない処理（POST /analyze 等）でも
 * 「経過秒数」と「想定完了時間」から残り秒数を計算して表示する。
 *
 * - running=true の間、内部タイマで 0 → 95% までなめらかに進捗
 * - estimatedMs は「この処理は大体何ミリ秒で終わるか」の過去の平均値
 * - 親コンポーネントが完了を検知して running=false にすると 100% へジャンプ
 * - バックエンドから実進捗が来る場合は externalPercent を渡せばそちらを採用
 */

export interface ProgressOverlayProps {
  running: boolean;
  title?: string;
  subtitle?: string;
  /** 想定完了時間（ms）。デフォルト 18s（Document AI + PyMuPDF の実測平均） */
  estimatedMs?: number;
  /** 外部から渡す実進捗(0-100)。指定時は自動ランプより優先 */
  externalPercent?: number | null;
}

const formatSec = (totalSec: number): string => {
  if (totalSec < 0 || !isFinite(totalSec)) return '--:--';
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const ProgressOverlay: React.FC<ProgressOverlayProps> = ({
  running,
  title = '処理中...',
  subtitle,
  estimatedMs = 18000,
  externalPercent = null,
}) => {
  const [percent, setPercent] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number | null>(null);
  const wasRunningRef = useRef<boolean>(false);

  useEffect(() => {
    if (!running) {
      // running が true → false に変わった時だけ完了アニメを発火
      if (wasRunningRef.current) {
        wasRunningRef.current = false;
        setPercent(100);
        const t = setTimeout(() => {
          setPercent(0);
          setElapsedMs(0);
          startRef.current = null;
        }, 400);
        return () => clearTimeout(t);
      }
      return;
    }
    // 起動（running が false → true）
    wasRunningRef.current = true;
    if (startRef.current === null) startRef.current = Date.now();
    setPercent(0);
    setElapsedMs(0);

    const id = setInterval(() => {
      const now = Date.now();
      const e = now - (startRef.current ?? now);
      setElapsedMs(e);
      // externalPercent があれば優先
      if (externalPercent !== null && externalPercent !== undefined) {
        setPercent(Math.max(0, Math.min(100, externalPercent)));
      } else {
        // estimatedMs に対する比率をそのまま、ただし 95% で頭打ち
        const ratio = Math.min(0.95, e / estimatedMs);
        setPercent(Math.floor(ratio * 100));
      }
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, estimatedMs]);

  // externalPercent が変わった瞬間に即反映
  useEffect(() => {
    if (externalPercent !== null && externalPercent !== undefined && running) {
      setPercent(Math.max(0, Math.min(100, externalPercent)));
    }
  }, [externalPercent, running]);

  if (!running && percent === 0) return null;

  const elapsedSec = elapsedMs / 1000;
  // 残り秒数: 経過／進捗率 から総時間を推定
  // 進捗が小さすぎる間は estimatedMs を使う
  let remainingSec: number;
  if (percent >= 100) {
    remainingSec = 0;
  } else if (percent < 3) {
    remainingSec = Math.max(0, (estimatedMs - elapsedMs) / 1000);
  } else {
    const totalEstimated = (elapsedMs / percent) * 100;
    remainingSec = Math.max(0, (totalEstimated - elapsedMs) / 1000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-white/70">
      <div className="w-[360px] max-w-[90vw] rounded-2xl bg-white border shadow-2xl p-6" style={{ borderColor: '#e5e7eb' }}>
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(99,102,241,.1)' }}>
            <div className="w-5 h-5 border-2 border-indigo-300 rounded-full animate-spin" style={{ borderTopColor: '#6366f1' }} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-bold text-slate-800">{title}</div>
            {subtitle && <div className="text-[11px] text-slate-500 mt-0.5">{subtitle}</div>}
          </div>
          <div className="text-2xl font-mono font-bold tabular-nums" style={{ color: '#6366f1' }}>
            {percent}%
          </div>
        </div>

        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: '#f1f5f9' }}>
          <div
            className="h-full transition-[width] duration-200 ease-out"
            style={{
              width: `${percent}%`,
              background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #06b6d4)',
              backgroundSize: '200% 100%',
              animation: 'gradient-shift 2s linear infinite',
            }}
          />
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500 font-mono tabular-nums">
          <div>経過: <span className="text-slate-800 font-semibold">{formatSec(elapsedSec)}</span></div>
          <div>残り: <span className="text-slate-800 font-semibold">{percent >= 100 ? '00:00' : formatSec(remainingSec)}</span></div>
        </div>
      </div>
      <style>{`@keyframes gradient-shift { 0% { background-position: 0% 0%; } 100% { background-position: 200% 0%; } }`}</style>
    </div>
  );
};

export default ProgressOverlay;
