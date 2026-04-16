import React, { useEffect, useRef, useState } from 'react';
import { Designer } from '@pdfme/ui';
import { generate } from '@pdfme/generator';
import { text, image, barcodes, line, table, rectangle, ellipse, svg, multiVariableText, date, dateTime, time, select, checkbox, radioGroup, signature } from '@pdfme/schemas';
import type { Template } from '@pdfme/common';
import { BLANK_PDF } from '@pdfme/common';
import {
  Save, Download, Upload, FileText, Trash2,
  Plus, Eye, LayoutTemplate, ChevronDown,
} from 'lucide-react';

/* ─────────────── Preset Templates ─────────────── */

const MEISHI_91x55: Template = {
  basePdf: { width: 91, height: 55, padding: [3, 3, 3, 3] },
  schemas: [[
    { name: '会社名', type: 'text', position: { x: 5, y: 5 }, width: 50, height: 6, fontSize: 8 },
    { name: '部署・役職', type: 'text', position: { x: 5, y: 12 }, width: 50, height: 5, fontSize: 7 },
    { name: '氏名', type: 'text', position: { x: 5, y: 20 }, width: 50, height: 10, fontSize: 14 },
    { name: '氏名（英語）', type: 'text', position: { x: 5, y: 30 }, width: 50, height: 5, fontSize: 7 },
    { name: '〒・住所', type: 'text', position: { x: 5, y: 38 }, width: 80, height: 5, fontSize: 6 },
    { name: 'TEL', type: 'text', position: { x: 5, y: 44 }, width: 40, height: 4, fontSize: 6 },
    { name: 'Email', type: 'text', position: { x: 5, y: 48 }, width: 50, height: 4, fontSize: 6 },
    { name: 'ロゴ', type: 'image', position: { x: 65, y: 5 }, width: 22, height: 15 },
  ] as any],
};

const NEWSPAPER_TEMPLATE: Template = {
  basePdf: { width: 297, height: 420, padding: [10, 10, 10, 10] },
  schemas: [[
    { name: '新聞タイトル', type: 'text', position: { x: 10, y: 10 }, width: 277, height: 20, fontSize: 36, alignment: 'center' },
    { name: '日付', type: 'text', position: { x: 10, y: 32 }, width: 100, height: 6, fontSize: 8 },
    { name: '号数', type: 'text', position: { x: 240, y: 32 }, width: 47, height: 6, fontSize: 8, alignment: 'right' },
    { name: '見出し1', type: 'text', position: { x: 10, y: 45 }, width: 135, height: 12, fontSize: 20 },
    { name: '記事1', type: 'text', position: { x: 10, y: 60 }, width: 135, height: 100, fontSize: 9 },
    { name: '写真1', type: 'image', position: { x: 152, y: 45 }, width: 135, height: 80 },
    { name: '見出し2', type: 'text', position: { x: 152, y: 130 }, width: 135, height: 10, fontSize: 16 },
    { name: '記事2', type: 'text', position: { x: 152, y: 142 }, width: 135, height: 80, fontSize: 9 },
  ] as any],
};

const BOOK_A5_TEMPLATE: Template = {
  basePdf: { width: 148, height: 210, padding: [15, 15, 15, 15] },
  schemas: [[
    { name: 'ヘッダー', type: 'text', position: { x: 15, y: 10 }, width: 118, height: 5, fontSize: 7, alignment: 'center' },
    { name: '章タイトル', type: 'text', position: { x: 15, y: 25 }, width: 118, height: 15, fontSize: 22 },
    { name: '本文', type: 'text', position: { x: 15, y: 50 }, width: 118, height: 140, fontSize: 10 },
    { name: 'ページ番号', type: 'text', position: { x: 65, y: 198 }, width: 18, height: 5, fontSize: 8, alignment: 'center' },
  ] as any],
};

const A4_BLANK: Template = {
  basePdf: BLANK_PDF,
  schemas: [[]],
};

type PresetKey = 'meishi' | 'newspaper' | 'book' | 'blank';
const PRESETS: Record<PresetKey, { label: string; icon: string; template: Template; desc: string }> = {
  meishi: { label: '名刺 (91×55mm)', icon: '💳', template: MEISHI_91x55, desc: '標準的な日本の名刺サイズ' },
  newspaper: { label: '新聞 (A3)', icon: '📰', template: NEWSPAPER_TEMPLATE, desc: '4段組レイアウトの新聞テンプレート' },
  book: { label: '書籍 (A5)', icon: '📖', template: BOOK_A5_TEMPLATE, desc: 'A5判の書籍ページテンプレート' },
  blank: { label: '白紙 (A4)', icon: '📄', template: A4_BLANK, desc: 'A4白紙から自由に作成' },
};

/* ─────────────── Plugin Registry ─────────────── */

const getPlugins = () => {
  const plugins: Record<string, any> = { Text: text, Image: image };
  try { if (multiVariableText) plugins['MultiVariableText'] = multiVariableText; } catch {}
  try { if (barcodes?.qrcode) plugins['QRCode'] = barcodes.qrcode; } catch {}
  try { if (barcodes?.code128) plugins['Code128'] = barcodes.code128; } catch {}
  try { if (barcodes?.ean13) plugins['EAN13'] = barcodes.ean13; } catch {}
  try { if (line) plugins['Line'] = line; } catch {}
  try { if (rectangle) plugins['Rectangle'] = rectangle; } catch {}
  try { if (ellipse) plugins['Ellipse'] = ellipse; } catch {}
  try { if (svg) plugins['SVG'] = svg; } catch {}
  try { if (table) plugins['Table'] = table; } catch {}
  try { if (dateTime) plugins['DateTime'] = dateTime; } catch {}
  try { if (date) plugins['Date'] = date; } catch {}
  try { if (time) plugins['Time'] = time; } catch {}
  try { if (select) plugins['Select'] = select; } catch {}
  try { if (checkbox) plugins['Checkbox'] = checkbox; } catch {}
  try { if (radioGroup) plugins['RadioGroup'] = radioGroup; } catch {}
  try { if (signature) plugins['Signature'] = signature; } catch {}
  return plugins;
};

/* ─────────────── Component ─────────────── */

interface Props {
  category: 'meishi' | 'newspaper' | 'book';
  onBack: () => void;
  flash: (msg: string, type: 'ok' | 'error' | 'info') => void;
  colors: Record<string, string>;
}

const TemplateDesigner: React.FC<Props> = ({ category, onBack, flash, colors: C }) => {
  const designerRef = useRef<HTMLDivElement>(null);
  const designerInstance = useRef<Designer | null>(null);
  const [currentTemplate, setCurrentTemplate] = useState<Template | null>(null);
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; template: Template }[]>([]);
  const [mode, setMode] = useState<'picker' | 'designer'>('picker');
  const [pendingTemplate, setPendingTemplate] = useState<Template | null>(null);
  const [templateName, setTemplateName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load saved templates from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`pdfme_templates_${category}`);
      if (saved) setSavedTemplates(JSON.parse(saved));
    } catch {}
  }, [category]);

  // KEY FIX: Initialize designer AFTER DOM is rendered
  useEffect(() => {
    if (mode !== 'designer' || !pendingTemplate || !designerRef.current) return;

    // Small delay to ensure DOM is fully laid out
    const timer = setTimeout(() => {
      if (!designerRef.current) return;

      // Destroy any previous instance
      if (designerInstance.current) {
        try { designerInstance.current.destroy(); } catch {}
        designerInstance.current = null;
      }

      const plugins = getPlugins();
      try {
        const d = new Designer({
          domContainer: designerRef.current,
          template: pendingTemplate,
          plugins,
          options: {
            lang: 'ja',
            theme: { token: { colorPrimary: '#6366f1' } },
          } as any,
        });

        d.onChangeTemplate((t: Template) => {
          setCurrentTemplate(t);
        });

        designerInstance.current = d;
        setCurrentTemplate(pendingTemplate);
        setPendingTemplate(null);
        flash('テンプレートデザイナーを起動しました', 'ok');
      } catch (err: any) {
        console.error('Designer init failed:', err);
        flash(`デザイナー初期化エラー: ${err.message}`, 'error');
        setMode('picker');
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [mode, pendingTemplate, flash]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (designerInstance.current) {
        try { designerInstance.current.destroy(); } catch {}
      }
    };
  }, []);

  // Select a template → switch to designer mode
  const selectTemplate = (template: Template, name: string) => {
    setTemplateName(name);
    setPendingTemplate(JSON.parse(JSON.stringify(template)));
    setMode('designer');
  };

  // Go back to picker
  const goBackToPicker = () => {
    if (designerInstance.current) {
      try { designerInstance.current.destroy(); } catch {}
      designerInstance.current = null;
    }
    setCurrentTemplate(null);
    setPendingTemplate(null);
    setMode('picker');
  };

  // Save template
  const handleSave = () => {
    const tpl = designerInstance.current
      ? designerInstance.current.getTemplate()
      : currentTemplate;
    if (!tpl) return;
    const name = templateName || `テンプレート_${new Date().toLocaleDateString('ja-JP')}`;
    const updated = [...savedTemplates.filter(t => t.name !== name), { name, template: tpl }];
    setSavedTemplates(updated);
    localStorage.setItem(`pdfme_templates_${category}`, JSON.stringify(updated));
    flash(`「${name}」を保存しました`, 'ok');
  };

  // Export template JSON
  const handleExportJSON = () => {
    const tpl = designerInstance.current
      ? designerInstance.current.getTemplate()
      : currentTemplate;
    if (!tpl) return;
    const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${templateName || 'template'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash('テンプレートJSONをエクスポートしました', 'ok');
  };

  // Import template JSON
  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const template = JSON.parse(reader.result as string);
        if (template.basePdf && template.schemas) {
          selectTemplate(template, file.name.replace('.json', ''));
          flash('テンプレートをインポートしました', 'ok');
        } else {
          flash('無効なテンプレートファイルです', 'error');
        }
      } catch {
        flash('JSONパースエラー', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Generate PDF
  const handleGeneratePDF = async () => {
    const tpl = designerInstance.current
      ? designerInstance.current.getTemplate()
      : currentTemplate;
    if (!tpl) return;
    flash('PDF生成中...', 'info');
    try {
      const plugins = getPlugins();
      const inputs: Record<string, string>[] = [{}];
      const schemas = tpl.schemas?.[0];
      if (Array.isArray(schemas)) {
        schemas.forEach((s: any) => {
          inputs[0][s.name] = s.content || s.name || '';
        });
      }
      const pdf = await generate({ template: tpl, inputs, plugins });
      const blob = new Blob([pdf.buffer], { type: 'application/pdf' });
      window.open(URL.createObjectURL(blob), '_blank');
      flash('PDFを生成しました', 'ok');
    } catch (err: any) {
      console.error('PDF generation failed:', err);
      flash(`PDF生成エラー: ${err.message}`, 'error');
    }
  };

  // Import basePdf
  const handleImportBasePdf = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = async (e: any) => {
      const file = e.target?.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const uint8 = new Uint8Array(reader.result as ArrayBuffer);
        let binary = '';
        uint8.forEach(b => binary += String.fromCharCode(b));
        const dataUrl = `data:application/pdf;base64,${btoa(binary)}`;
        if (designerInstance.current) {
          const tpl = designerInstance.current.getTemplate();
          const updated = { ...tpl, basePdf: dataUrl };
          designerInstance.current.updateTemplate(updated);
          setCurrentTemplate(updated);
          flash('ベースPDFを更新しました', 'ok');
        }
      };
      reader.readAsArrayBuffer(file);
    };
    input.click();
  };

  // ── Preset Picker ──
  if (mode === 'picker') {
    const presetKeys: PresetKey[] = category === 'meishi' ? ['meishi', 'blank'] :
      category === 'newspaper' ? ['newspaper', 'blank'] : ['book', 'blank'];

    return (
      <div className="flex-1 overflow-auto p-8" style={{ background: C.bg }}>
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-4 mb-8">
            <button onClick={onBack} className="p-2 rounded-xl hover:bg-gray-100 transition-all">
              <ChevronDown size={20} className="rotate-90" style={{ color: C.textSec }} />
            </button>
            <div>
              <h2 className="text-2xl font-bold text-gray-900">テンプレートデザイナー</h2>
              <p className="text-sm text-gray-500 mt-1">
                {category === 'meishi' ? '名刺' : category === 'newspaper' ? '新聞' : '商業出版'}のテンプレートを作成・編集
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            {presetKeys.map(key => {
              const p = PRESETS[key];
              return (
                <button
                  key={key}
                  onClick={() => selectTemplate(p.template, p.label)}
                  className="group relative bg-white rounded-2xl p-8 border-2 border-transparent hover:border-indigo-400 transition-all shadow-sm hover:shadow-xl text-left"
                >
                  <div className="flex items-start gap-4">
                    <div className="text-4xl">{p.icon}</div>
                    <div>
                      <h3 className="text-lg font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">{p.label}</h3>
                      <p className="text-sm text-gray-500 mt-1">{p.desc}</p>
                    </div>
                  </div>
                  <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Plus size={20} className="text-indigo-500" />
                  </div>
                </button>
              );
            })}
          </div>

          {savedTemplates.length > 0 && (
            <div className="mb-8">
              <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                <LayoutTemplate size={18} /> 保存済みテンプレート
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {savedTemplates.map((t, i) => (
                  <div key={i} className="bg-white rounded-xl p-4 border border-gray-200 hover:border-indigo-300 transition-all group">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-gray-800 truncate">{t.name}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const updated = savedTemplates.filter((_, idx) => idx !== i);
                          setSavedTemplates(updated);
                          localStorage.setItem(`pdfme_templates_${category}`, JSON.stringify(updated));
                          flash('テンプレートを削除しました', 'info');
                        }}
                        className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <button
                      onClick={() => selectTemplate(t.template, t.name)}
                      className="w-full text-left text-xs text-indigo-500 font-medium hover:text-indigo-700"
                    >
                      編集する →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-4">
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportJSON} />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-5 py-3 rounded-xl border-2 border-dashed border-gray-300 text-gray-500 hover:border-indigo-400 hover:text-indigo-600 transition-all text-sm font-medium"
            >
              <Upload size={16} /> テンプレートJSONをインポート
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Designer View ──
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: C.bg }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-3">
          <button onClick={goBackToPicker} className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors">
            <ChevronDown size={16} className="rotate-90" /> 戻る
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <input
            type="text"
            value={templateName}
            onChange={e => setTemplateName(e.target.value)}
            placeholder="テンプレート名"
            className="text-sm font-medium border-none outline-none bg-transparent w-48 text-gray-800"
          />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleImportBasePdf} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 text-gray-600 transition-all" title="ベースPDFをインポート">
            <FileText size={13} /> ベースPDF
          </button>
          <button onClick={handleSave} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 text-gray-600 transition-all">
            <Save size={13} /> 保存
          </button>
          <button onClick={handleExportJSON} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 text-gray-600 transition-all">
            <Download size={13} /> JSON
          </button>
          <button onClick={handleGeneratePDF} className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white transition-all hover:opacity-90 shadow-md" style={{ background: C.gradientPrimary }}>
            <Eye size={13} /> PDF生成
          </button>
        </div>
      </div>

      {/* Designer Container — pdfme mounts here */}
      <div ref={designerRef} className="flex-1" style={{ minHeight: 0, height: '100%' }} />
    </div>
  );
};

export default TemplateDesigner;
