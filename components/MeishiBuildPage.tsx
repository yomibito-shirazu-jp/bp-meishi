import React, { useState, useRef } from 'react';
import JSZip from 'jszip';
import { Upload, Download, Play, Eye, Columns, Layers } from 'lucide-react';
import { dtpAgentLayout, vivliostyleBuild } from '../services/api';

type CompareMode = 'side' | 'overlay';

export const MeishiBuildPage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'idle'|'building'|'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [originalPdfB64, setOriginalPdfB64] = useState<string | null>(null);
  const [originalPngB64, setOriginalPngB64] = useState<string | null>(null);
  const [generatedPdfB64, setGeneratedPdfB64] = useState<string | null>(null);
  const [generatedHtml, setGeneratedHtml] = useState('');
  const [generatedCss, setGeneratedCss] = useState('');
  const [compareMode, setCompareMode] = useState<CompareMode>('side');
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [activePanel, setActivePanel] = useState<'preview'|'code'>('preview');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleZip = async (file: File) => {
    setLoading(true); setError(null); setStep('building');
    setOriginalPdfB64(null); setGeneratedPdfB64(null);
    try {
      const zip = await JSZip.loadAsync(file);

      const instructionStr = await zip.file('instruction.json')?.async('string') || '{}';
      const contentText = await zip.file('content.txt')?.async('string') || '';
      const instruction = JSON.parse(instructionStr);

      // Original PDF
      const pdfEntry = zip.file('original.pdf');
      if (pdfEntry) {
        const b64 = await pdfEntry.async('base64');
        setOriginalPdfB64(b64);
      }

      // Images from zip
      const images: { id: string; b64: string }[] = [];
      const imgPromises: Promise<void>[] = [];
      zip.forEach((path, entry) => {
        if (path.startsWith('image_') && path.endsWith('.png')) {
          imgPromises.push(entry.async('base64').then(b64 => {
            images.push({ id: path.replace('image_', '').replace('.png', ''), b64 });
          }));
        }
      });
      await Promise.all(imgPromises);

      // DTP Agent
      const layout = await dtpAgentLayout({ instruction_manual: instruction, content_text: contentText });
      setGeneratedHtml(layout.html);
      setGeneratedCss(layout.css);

      // Build PDF
      const built = await vivliostyleBuild(
        [], [91, 55], '名刺', undefined,
        layout.html, layout.css,
        `meishi_build_${Date.now()}`,
        images
      );
      setGeneratedPdfB64(built.pdf_b64);
      setStep('done');
    } catch (e: any) {
      setError(e.message || 'PDF生成エラー');
      setStep('idle');
    } finally {
      setLoading(false);
    }
  };

  const downloadPdf = () => {
    if (!generatedPdfB64) return;
    const a = document.createElement('a');
    a.href = `data:application/pdf;base64,${generatedPdfB64}`;
    a.download = `meishi_output_${Date.now()}.pdf`;
    a.click();
  };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#0f0f14 0%,#1a1a2e 100%)', padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        <h1 style={{ color: '#e2e8f0', fontSize: 28, fontWeight: 800, marginBottom: 8 }}>🖨️ 名刺PDF生成</h1>
        <p style={{ color: '#64748b', marginBottom: 32 }}>抽出ZIPをアップロードしてPDFを生成し、元データと比較します</p>

        {/* Upload */}
        {step === 'idle' && (
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleZip(f); }}
            style={{ border: '2px dashed #8b5cf6', borderRadius: 16, padding: 64, textAlign: 'center', cursor: 'pointer', background: 'rgba(139,92,246,.06)' }}
          >
            <Upload size={48} style={{ color: '#8b5cf6', margin: '0 auto 16px' }} />
            <p style={{ color: '#e2e8f0', fontSize: 18, fontWeight: 700 }}>ZIPファイルをドロップまたはクリック</p>
            <p style={{ color: '#64748b', marginTop: 8 }}>抽出ページでダウンロードしたmeishi_assets.zipを使用してください</p>
            <input ref={fileRef} type="file" accept=".zip" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleZip(f); }} />
          </div>
        )}

        {/* Building */}
        {loading && (
          <div style={{ background: '#1a1a2e', border: '1px solid rgba(139,92,246,.3)', borderRadius: 16, padding: 40, textAlign: 'center' }}>
            <div style={{ width: 48, height: 48, border: '4px solid rgba(139,92,246,.2)', borderTop: '4px solid #8b5cf6', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <p style={{ color: '#e2e8f0', fontSize: 18, fontWeight: 700 }}>DTPエージェント実行中...</p>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* Error */}
        {error && <div style={{ background: '#450a0a', border: '1px solid #ef4444', borderRadius: 12, padding: 16, color: '#fca5a5' }}>{error}</div>}

        {/* Result: Comparison Player */}
        {step === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', background: '#1a1a2e', borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', overflow: 'hidden' }}>
                {([['side', <Columns size={16} />, '並列比較'], ['overlay', <Layers size={16} />, 'オーバーレイ']] as const).map(([mode, icon, label]) => (
                  <button key={mode} onClick={() => setCompareMode(mode as CompareMode)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', border: 'none', cursor: 'pointer', background: compareMode === mode ? '#6366f1' : 'transparent', color: compareMode === mode ? '#fff' : '#64748b', fontSize: 13, fontWeight: 600 }}>
                    {icon} {label}
                  </button>
                ))}
              </div>

              {compareMode === 'overlay' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#64748b', fontSize: 13 }}>透明度</span>
                  <input type="range" min={0} max={1} step={0.05} value={overlayOpacity}
                    onChange={e => setOverlayOpacity(Number(e.target.value))}
                    style={{ width: 120, accentColor: '#6366f1' }} />
                  <span style={{ color: '#94a3b8', fontSize: 13 }}>{Math.round(overlayOpacity * 100)}%</span>
                </div>
              )}

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {(['preview', 'code'] as const).map(p => (
                  <button key={p} onClick={() => setActivePanel(p)}
                    style={{ padding: '8px 16px', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, background: activePanel === p ? '#6366f1' : '#1a1a2e', color: activePanel === p ? '#fff' : '#64748b', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    {p === 'preview' ? <><Eye size={14} style={{ display:'inline',marginRight:4 }} />プレビュー</> : 'HTML/CSS'}
                  </button>
                ))}
                <button onClick={downloadPdf} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 20px', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  <Download size={16} /> PDFダウンロード
                </button>
              </div>
            </div>

            {activePanel === 'preview' && (
              <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,.08)', background: '#0f0f14' }}>
                {compareMode === 'side' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: 520 }}>
                    {/* Original */}
                    <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid rgba(255,255,255,.08)' }}>
                      <div style={{ padding: '10px 16px', background: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,.06)', color: '#64748b', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} /> 元データ
                      </div>
                      {originalPdfB64 ? (
                        <iframe title="original" style={{ flex: 1, border: 'none', background: '#fff' }}
                          src={`data:application/pdf;base64,${originalPdfB64}`} />
                      ) : originalPngB64 ? (
                        <img src={`data:image/png;base64,${originalPngB64}`} style={{ flex: 1, objectFit: 'contain', background: '#fff' }} alt="original" />
                      ) : (
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' }}>
                          元PDFなし（ZIPにoriginal.pdfが含まれていません）
                        </div>
                      )}
                    </div>
                    {/* Generated */}
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <div style={{ padding: '10px 16px', background: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,.06)', color: '#64748b', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} /> 生成結果
                      </div>
                      {generatedPdfB64 ? (
                        <iframe title="generated" style={{ flex: 1, border: 'none', background: '#fff' }}
                          src={`data:application/pdf;base64,${generatedPdfB64}`} />
                      ) : (
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' }}>PDF生成失敗</div>
                      )}
                    </div>
                  </div>
                ) : (
                  // Overlay mode
                  <div style={{ height: 520, position: 'relative', background: '#fff' }}>
                    {originalPdfB64 && (
                      <iframe title="original-overlay" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
                        src={`data:application/pdf;base64,${originalPdfB64}`} />
                    )}
                    {generatedPdfB64 && (
                      <iframe title="generated-overlay" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', opacity: overlayOpacity }}
                        src={`data:application/pdf;base64,${generatedPdfB64}`} />
                    )}
                    <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(0,0,0,.7)', color: '#fff', borderRadius: 6, padding: '4px 10px', fontSize: 11 }}>
                      赤=元 / 緑=生成 (透明度: {Math.round(overlayOpacity * 100)}%)
                    </div>
                  </div>
                )}
              </div>
            )}

            {activePanel === 'code' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, height: 520 }}>
                {[['HTML', generatedHtml, '#4ade80'], ['CSS', generatedCss, '#60a5fa']].map(([label, code, color]) => (
                  <div key={label as string} style={{ background: '#0d1117', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,.06)', color: '#64748b', fontSize: 12, fontWeight: 700 }}>{label as string}</div>
                    <pre style={{ flex: 1, margin: 0, padding: 16, color: color as string, fontSize: 11, overflow: 'auto', fontFamily: 'monospace' }}>{code as string}</pre>
                  </div>
                ))}
              </div>
            )}

            {/* Reset */}
            <button onClick={() => { setStep('idle'); setGeneratedPdfB64(null); setOriginalPdfB64(null); }}
              style={{ alignSelf: 'flex-start', padding: '10px 20px', background: '#1a1a2e', color: '#64748b', border: '1px solid rgba(255,255,255,.1)', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>
              別のZIPを読み込む
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
