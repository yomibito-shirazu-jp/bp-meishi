import React, { useState, useRef } from 'react';
import JSZip from 'jszip';
import { Upload, Download, FileText, Image as Img, Database, CheckCircle } from 'lucide-react';
import { analyzePdf, extractInstruction } from '../services/api';
import { saveProject } from '../services/supabase';
import type { PageData } from '../types';

interface ExtractResult {
  page: PageData;
  pdf_b64: string;
  instruction: any;
  text: string;
}

export const MeishiExtractPage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'idle'|'analyzing'|'extracting'|'saving'|'done'>('idle');
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.name.endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('PDFファイルを選択してください'); return;
    }
    setLoading(true); setError(null); setSaved(false); setResult(null);
    try {
      setStep('analyzing');
      const analyzed = await analyzePdf(file, true);
      const page = analyzed.pages[0];
      const text = page.spans.map(s => s.text).join('\n');

      setStep('extracting');
      const instruction = await extractInstruction({ content_text: text, analyze_data: analyzed });

      const r: ExtractResult = { page, pdf_b64: analyzed.pdf_b64, instruction, text };
      setResult(r);

      setStep('saving');
      const proj = {
        id: crypto.randomUUID(),
        name: text.split('\n')[0]?.slice(0, 30) || '名刺',
        spans: page.spans,
        original_spans: page.spans,
        pdf_b64: analyzed.pdf_b64,
        page_mm: page.page_mm,
        original_png_b64: page.original_png_b64,
        raw_id_map: page.raw_id_map,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await saveProject(proj as any);
      setSaved(true);
      setStep('done');
    } catch (e: any) {
      setError(e.message || 'エラーが発生しました');
      setStep('idle');
    } finally {
      setLoading(false);
    }
  };

  const downloadZip = async () => {
    if (!result) return;
    const zip = new JSZip();
    zip.file('instruction.json', JSON.stringify(result.instruction, null, 2));
    zip.file('content.txt', result.text);
    if (result.pdf_b64) zip.file('original.pdf', result.pdf_b64, { base64: true });
    result.page.images.forEach(img => {
      zip.file(`image_${img.id}.png`, img.data_b64, { base64: true });
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'meishi_assets.zip'; a.click();
  };

  const stepLabel: Record<string, string> = {
    idle: '待機中', analyzing: 'PDF解析中...', extracting: '指示書生成中...', saving: 'DB保存中...', done: '完了'
  };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#0f0f14 0%,#1a1a2e 100%)', padding: 32 }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ color: '#e2e8f0', fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
          📋 名刺コンテンツ抽出
        </h1>
        <p style={{ color: '#64748b', marginBottom: 32 }}>
          PDFから組版指示書・テキスト・画像を抽出してZIPで保存します
        </p>

        {/* Upload Area */}
        {step === 'idle' && (
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            style={{
              border: '2px dashed #6366f1', borderRadius: 16, padding: 64,
              textAlign: 'center', cursor: 'pointer', background: 'rgba(99,102,241,.06)',
              transition: 'all .2s',
            }}
          >
            <Upload size={48} style={{ color: '#6366f1', margin: '0 auto 16px' }} />
            <p style={{ color: '#e2e8f0', fontSize: 18, fontWeight: 700 }}>PDFをドロップまたはクリック</p>
            <p style={{ color: '#64748b', marginTop: 8 }}>名刺PDFから組版指示書を自動生成します</p>
            <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        )}

        {/* Progress */}
        {loading && (
          <div style={{ background: '#1a1a2e', border: '1px solid rgba(99,102,241,.3)', borderRadius: 16, padding: 40, textAlign: 'center' }}>
            <div style={{ width: 48, height: 48, border: '4px solid rgba(99,102,241,.2)', borderTop: '4px solid #6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <p style={{ color: '#e2e8f0', fontSize: 18, fontWeight: 700 }}>{stepLabel[step]}</p>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* Error */}
        {error && <div style={{ background: '#450a0a', border: '1px solid #ef4444', borderRadius: 12, padding: 16, color: '#fca5a5', marginBottom: 16 }}>{error}</div>}

        {/* Result */}
        {result && step === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Status */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { icon: <FileText size={18} />, label: `テキスト ${result.page.spans.length}件`, color: '#6366f1' },
                { icon: <Img size={18} />, label: `画像 ${result.page.images.length}件`, color: '#8b5cf6' },
                { icon: <Database size={18} />, label: saved ? 'DB保存済み' : 'DB保存失敗', color: saved ? '#10b981' : '#ef4444' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#1a1a2e', border: `1px solid ${item.color}40`, borderRadius: 8, padding: '8px 16px', color: item.color }}>
                  {item.icon} <span style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600 }}>{item.label}</span>
                </div>
              ))}
              {saved && <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#10b981' }}><CheckCircle size={20} /><span style={{ fontWeight: 700 }}>保存完了</span></div>}
            </div>

            {/* Preview grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Original preview */}
              <div style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,.06)', color: '#94a3b8', fontSize: 13, fontWeight: 700 }}>元PDF プレビュー</div>
                {result.page.original_png_b64 ? (
                  <img src={`data:image/png;base64,${result.page.original_png_b64}`} alt="original" style={{ width: '100%', objectFit: 'contain', maxHeight: 300, background: '#fff' }} />
                ) : <div style={{ padding: 32, color: '#475569', textAlign: 'center' }}>プレビューなし</div>}
              </div>

              {/* Instruction JSON preview */}
              <div style={{ background: '#0d1117', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,.06)', color: '#94a3b8', fontSize: 13, fontWeight: 700 }}>組版指示書 JSON</div>
                <pre style={{ flex: 1, padding: 16, margin: 0, color: '#4ade80', fontSize: 11, overflow: 'auto', maxHeight: 260, fontFamily: 'monospace' }}>
                  {JSON.stringify(result.instruction, null, 2).slice(0, 1500)}...
                </pre>
              </div>
            </div>

            {/* Images */}
            {result.page.images.length > 0 && (
              <div style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12, padding: 16 }}>
                <p style={{ color: '#94a3b8', fontSize: 13, fontWeight: 700, marginBottom: 12 }}>抽出画像</p>
                <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
                  {result.page.images.map(img => (
                    <div key={img.id} style={{ flexShrink: 0, background: '#0f0f14', border: '1px solid rgba(255,255,255,.06)', borderRadius: 8, padding: 8, width: 120 }}>
                      <img src={`data:image/png;base64,${img.data_b64}`} alt={img.id} style={{ width: '100%', height: 80, objectFit: 'contain', background: '#fff', borderRadius: 4 }} />
                      <p style={{ color: '#64748b', fontSize: 10, marginTop: 4, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{img.id}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={downloadZip} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 24px', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>
                <Download size={20} /> ZIPダウンロード
              </button>
              <button onClick={() => { setStep('idle'); setResult(null); setSaved(false); }} style={{ padding: '14px 24px', background: '#1a1a2e', color: '#94a3b8', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
                別のPDFを読み込む
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
