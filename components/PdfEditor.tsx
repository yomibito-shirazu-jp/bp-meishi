import React, { useEffect, useRef, useState } from 'react';
import { Designer } from '@pdfme/ui';
import { generate } from '@pdfme/generator';
import { text, image, rectangle, ellipse, line, svg, table, multiVariableText } from '@pdfme/schemas';
import type { Template } from '@pdfme/common';
import { BLANK_PDF } from '@pdfme/common';
import {
  Upload, Download, FileText, Eye, Save, RotateCcw,
  Type, Square, Minus, Image as ImageIcon, PenTool,
} from 'lucide-react';
import { getPdfmeFont } from './fontHelper';

/* ─────── Plugin registry ─────── */
const getPlugins = () => {
  const p: Record<string, any> = { Text: text, Image: image };
  try { if (rectangle) p['Rectangle'] = rectangle; } catch {}
  try { if (ellipse) p['Ellipse'] = ellipse; } catch {}
  try { if (line) p['Line'] = line; } catch {}
  try { if (svg) p['SVG'] = svg; } catch {}
  try { if (table) p['Table'] = table; } catch {}
  try { if (multiVariableText) p['MultiVariableText'] = multiVariableText; } catch {}
  return p;
};

interface Props {
  onBack: () => void;
  flash: (msg: string, type: 'ok' | 'error' | 'info') => void;
  colors: Record<string, string>;
}

const PdfEditor: React.FC<Props> = ({ onBack, flash, colors: C }) => {
  const designerRef = useRef<HTMLDivElement>(null);
  const designerInstance = useRef<Designer | null>(null);
  const [hasDesigner, setHasDesigner] = useState(false);
  const [pendingPdf, setPendingPdf] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize designer when pendingPdf changes and DOM is ready
  useEffect(() => {
    if (!pendingPdf || !designerRef.current) return;
    let isMounted = true;

    const timer = setTimeout(async () => {
      if (!designerRef.current) return;

      // Destroy previous
      if (designerInstance.current) {
        try { designerInstance.current.destroy(); } catch {}
        designerInstance.current = null;
      }

      const template: Template = {
        basePdf: pendingPdf,
        schemas: [[]],
      };

      try {
        const font = await getPdfmeFont();
        if (!isMounted) return;

        const d = new Designer({
          domContainer: designerRef.current,
          template,
          plugins: getPlugins(),
          options: {
            font,
            lang: 'ja',
            theme: { token: { colorPrimary: '#f59e0b' } },
          } as any,
        });

        designerInstance.current = d;
        setHasDesigner(true);
        setPendingPdf(null);
        flash('PDFを読み込みました。テキスト・矩形（白塗り）を追加して編集できます。', 'ok');
      } catch (err: any) {
        console.error('Designer init failed:', err);
        flash(`エディタ初期化エラー: ${err.message}`, 'error');
      }
    }, 150);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [pendingPdf, flash]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (designerInstance.current) {
        try { designerInstance.current.destroy(); } catch {}
      }
    };
  }, []);

  // Load PDF file
  const handleLoadPdf = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
      flash('PDFファイルを選択してください', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const uint8 = new Uint8Array(reader.result as ArrayBuffer);
      let binary = '';
      uint8.forEach(b => binary += String.fromCharCode(b));
      const base64 = `data:application/pdf;base64,${btoa(binary)}`;
      setPendingPdf(base64);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  // Start with blank A4
  const handleBlankPdf = () => {
    setPendingPdf(BLANK_PDF);
  };

  // Generate & download PDF
  const handleExportPdf = async () => {
    if (!designerInstance.current) return;
    flash('PDF生成中...', 'info');
    try {
      const tpl = designerInstance.current.getTemplate();
      const plugins = getPlugins();
      const font = await getPdfmeFont();
      const inputs: Record<string, string>[] = [{}];
      const schemas = tpl.schemas?.[0];
      if (Array.isArray(schemas)) {
        schemas.forEach((s: any) => {
          inputs[0][s.name] = s.content || s.name || '';
        });
      }
      const pdf = await generate({ template: tpl, inputs, plugins, options: { font } });
      const blob = new Blob([pdf.buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);

      // Download
      const a = document.createElement('a');
      a.href = url;
      a.download = `edited_${new Date().toISOString().slice(0,10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      flash('PDFをダウンロードしました', 'ok');
    } catch (err: any) {
      console.error('PDF export failed:', err);
      flash(`PDF生成エラー: ${err.message}`, 'error');
    }
  };

  // Preview PDF in new tab
  const handlePreviewPdf = async () => {
    if (!designerInstance.current) return;
    flash('プレビュー生成中...', 'info');
    try {
      const tpl = designerInstance.current.getTemplate();
      const plugins = getPlugins();
      const font = await getPdfmeFont();
      const inputs: Record<string, string>[] = [{}];
      const schemas = tpl.schemas?.[0];
      if (Array.isArray(schemas)) {
        schemas.forEach((s: any) => {
          inputs[0][s.name] = s.content || s.name || '';
        });
      }
      const pdf = await generate({ template: tpl, inputs, plugins, options: { font } });
      const blob = new Blob([pdf.buffer], { type: 'application/pdf' });
      window.open(URL.createObjectURL(blob), '_blank');
      flash('プレビューを開きました', 'ok');
    } catch (err: any) {
      flash(`プレビューエラー: ${err.message}`, 'error');
    }
  };

  // Reset editor
  const handleReset = () => {
    if (designerInstance.current) {
      try { designerInstance.current.destroy(); } catch {}
      designerInstance.current = null;
    }
    setHasDesigner(false);
    setPendingPdf(null);
  };

  // ── Upload screen ──
  if (!hasDesigner && !pendingPdf) {
    return (
      <div className="flex-1 flex items-center justify-center p-8" style={{ background: C.bg }}>
        <div className="max-w-2xl w-full text-center">
          <div className="mb-8">
            <div className="w-20 h-20 mx-auto rounded-2xl flex items-center justify-center mb-4"
              style={{ background: 'linear-gradient(135deg, #f59e0b, #fbbf24)' }}>
              <PenTool size={36} className="text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">PDF加工・編集</h2>
            <p className="text-gray-500">
              PDFを読み込み、テキスト追加・白塗り修正・画像挿入を行い、編集済みPDFを出力します。
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {/* Load existing PDF */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group p-8 rounded-2xl border-2 border-dashed border-gray-300 hover:border-amber-400 transition-all hover:shadow-lg bg-white"
            >
              <Upload size={32} className="mx-auto mb-3 text-gray-400 group-hover:text-amber-500 transition-colors" />
              <h3 className="font-bold text-gray-900 mb-1">PDFファイルを開く</h3>
              <p className="text-sm text-gray-500">既存のPDFを読み込んで編集</p>
            </button>

            {/* Blank A4 */}
            <button
              onClick={handleBlankPdf}
              className="group p-8 rounded-2xl border-2 border-dashed border-gray-300 hover:border-amber-400 transition-all hover:shadow-lg bg-white"
            >
              <FileText size={32} className="mx-auto mb-3 text-gray-400 group-hover:text-amber-500 transition-colors" />
              <h3 className="font-bold text-gray-900 mb-1">白紙から作成</h3>
              <p className="text-sm text-gray-500">A4白紙から自由に編集</p>
            </button>
          </div>

          <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleLoadPdf} />

          <button onClick={onBack} className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
            ← 戻る
          </button>
        </div>
      </div>
    );
  }

  // ── Editor view ──
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: C.bg }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-3">
          <button onClick={handleReset} className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors">
            <RotateCcw size={14} /> 別のPDFを開く
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <span className="text-sm text-gray-600 font-medium">
            <PenTool size={14} className="inline mr-1" />
            PDF加工・編集
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-gray-400 mr-2 hidden md:block">
            左のパレットからテキスト・矩形を追加 → 白塗り修正
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 text-gray-600 transition-all"
          >
            <Upload size={13} /> PDF読込
          </button>
          <button
            onClick={handlePreviewPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 text-gray-600 transition-all"
          >
            <Eye size={13} /> プレビュー
          </button>
          <button
            onClick={handleExportPdf}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white transition-all hover:opacity-90 shadow-md"
            style={{ background: 'linear-gradient(135deg, #f59e0b, #fbbf24)' }}
          >
            <Download size={13} /> PDF出力
          </button>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleLoadPdf} />

      {/* pdfme Designer container */}
      <div ref={designerRef} className="flex-1" style={{ minHeight: 0, height: '100%' }} />
    </div>
  );
};

export default PdfEditor;
