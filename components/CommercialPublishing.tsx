import React, { useState, useRef, useEffect } from 'react';
import { Designer } from '@pdfme/ui';
import { generate } from '@pdfme/generator';
import { text, image, rectangle, ellipse, line, svg, table, multiVariableText } from '@pdfme/schemas';
import type { Template } from '@pdfme/common';
import { BLANK_PDF } from '@pdfme/common';
import { extractCorrections, CorrectionTask } from '../services/api';
import { getConfig } from '../services/config';
import {
  Upload, Download, Eye, FileText, BookMarked, ClipboardList,
  CheckCircle2, Circle, AlertTriangle, XCircle, ChevronDown, ChevronUp,
  RotateCcw, PenTool, ArrowLeft, Loader2, HardDrive, FileEdit,
  LayoutTemplate, Filter, ChevronRight,
} from 'lucide-react';
import { pickPdfFromDrive } from '../services/gdrive';
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
  onTemplateDesigner?: () => void;
}

type Phase = 'upload' | 'tasks' | 'editor';

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  text:   { label: '文字修正', color: '#3b82f6' },
  image:  { label: '画像',     color: '#f59e0b' },
  layout: { label: 'レイアウト', color: '#8b5cf6' },
  delete: { label: '削除',     color: '#ef4444' },
  add:    { label: '追加',     color: '#10b981' },
};

const PRIORITY_ICONS: Record<string, React.ReactNode> = {
  high:   <AlertTriangle size={13} className="text-red-500" />,
  normal: <Circle size={13} className="text-blue-400" />,
  low:    <Circle size={13} className="text-gray-300" />,
};

const CommercialPublishing: React.FC<Props> = ({ onBack, flash, colors: C, onTemplateDesigner }) => {
  const [phase, setPhase] = useState<Phase>('upload');

  // Upload state
  const [manuscriptPdf, setManuscriptPdf] = useState<{ file: File; b64: string } | null>(null);
  const [correctionPdf, setCorrectionPdf] = useState<{ file: File; b64: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const manuscriptRef = useRef<HTMLInputElement>(null);
  const correctionRef = useRef<HTMLInputElement>(null);

  // Task state
  const [tasks, setTasks] = useState<CorrectionTask[]>([]);
  const [correctionPreviews, setCorrectionPreviews] = useState<{ page_index: number; preview_b64: string }[]>([]);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  // Editor state
  const designerRef = useRef<HTMLDivElement>(null);
  const designerInstance = useRef<Designer | null>(null);
  const [hasDesigner, setHasDesigner] = useState(false);
  const [showTaskPanel, setShowTaskPanel] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── File reading helpers ──
  const readFileAsB64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const uint8 = new Uint8Array(reader.result as ArrayBuffer);
        let binary = '';
        uint8.forEach(b => binary += String.fromCharCode(b));
        resolve(btoa(binary));
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const readFileAsDataUri = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const uint8 = new Uint8Array(reader.result as ArrayBuffer);
        let binary = '';
        uint8.forEach(b => binary += String.fromCharCode(b));
        resolve(`data:application/pdf;base64,${btoa(binary)}`);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  // ── Upload handlers ──
  const handleManuscriptFile = async (file: File) => {
    if (!file.name.endsWith('.pdf')) { flash('PDFファイルを選択してください', 'error'); return; }
    const b64 = await readFileAsB64(file);
    setManuscriptPdf({ file, b64 });
    flash(`原稿PDF「${file.name}」を読み込みました`, 'ok');
  };

  const handleCorrectionFile = async (file: File) => {
    if (!file.name.endsWith('.pdf')) { flash('PDFファイルを選択してください', 'error'); return; }
    const b64 = await readFileAsB64(file);
    setCorrectionPdf({ file, b64 });
    flash(`修正指示PDF「${file.name}」を読み込みました`, 'ok');
  };

  // ── Extract corrections & go to tasks ──
  const handleExtractCorrections = async () => {
    if (!correctionPdf) { flash('修正指示PDFをアップロードしてください', 'error'); return; }
    setLoading(true);
    try {
      const result = await extractCorrections(correctionPdf.b64, manuscriptPdf?.b64);
      setTasks(result.tasks);
      setCorrectionPreviews(result.pages);
      setPhase('tasks');
      flash(`${result.total_tasks}件の修正タスクを抽出しました`, 'ok');
    } catch (err: any) {
      flash(`修正指示抽出エラー: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Skip corrections, go straight to editor ──
  const handleSkipToEditor = async () => {
    if (!manuscriptPdf) { flash('原稿PDFをアップロードしてください', 'error'); return; }
    setPhase('editor');
  };

  // ── Editor init ──
  useEffect(() => {
    if (phase !== 'editor' || !manuscriptPdf || !designerRef.current) return;

    const timer = setTimeout(async () => {
      if (!designerRef.current) return;

      // Destroy previous
      if (designerInstance.current) {
        try { designerInstance.current.destroy(); } catch {}
        designerInstance.current = null;
      }

      const dataUri = `data:application/pdf;base64,${manuscriptPdf.b64}`;
      const template: Template = {
        basePdf: dataUri,
        schemas: [[]],
      };

      try {
        const font = await getPdfmeFont();
        const d = new Designer({
          domContainer: designerRef.current,
          template,
          plugins: getPlugins(),
          options: {
            font,
            lang: 'ja',
            theme: { token: { colorPrimary: '#8b5cf6' } },
          } as any,
        });
        designerInstance.current = d;
        setHasDesigner(true);
        flash('原稿PDFをエディタに読み込みました', 'ok');
      } catch (err: any) {
        console.error('Designer init failed:', err);
        flash(`エディタ初期化エラー: ${err.message}`, 'error');
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [phase, manuscriptPdf]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (designerInstance.current) {
        try { designerInstance.current.destroy(); } catch {}
      }
    };
  }, []);

  // ── PDF Export ──
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
        schemas.forEach((s: any) => { inputs[0][s.name] = s.content || s.name || ''; });
      }
      const pdf = await generate({ template: tpl, inputs, plugins, options: { font } });
      const blob = new Blob([pdf.buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `corrected_${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      flash('修正済みPDFをダウンロードしました', 'ok');
    } catch (err: any) {
      flash(`PDF生成エラー: ${err.message}`, 'error');
    }
  };

  // ── Task toggle ──
  const toggleTaskStatus = (taskId: string) => {
    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, status: t.status === 'done' ? 'pending' : 'done' }
        : t
    ));
  };

  // ── Filtered tasks ──
  const filteredTasks = filterCategory === 'all'
    ? tasks
    : tasks.filter(t => t.category === filterCategory);

  const doneCount = tasks.filter(t => t.status === 'done').length;
  const progress = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;

  /* ════════════════════════════════════════════════════════════════
     Phase 1: Upload
     ════════════════════════════════════════════════════════════════ */
  if (phase === 'upload') {
    return (
      <div className="flex-1 overflow-auto p-8" style={{ background: C.bg }}>
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="mb-6">
            <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 mb-4 transition-colors">
              <ArrowLeft size={14} /> 戻る
            </button>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: C.gradientPrimary }}>
                <BookMarked size={24} className="text-white" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-gray-900">商業出版</h2>
                <p className="text-sm text-gray-500">原稿PDFと修正指示PDFをアップロード。修正指示からタスク表を自動生成し、pdfmeで直接編集。</p>
              </div>
            </div>
          </div>

          {/* Two upload areas */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            {/* Manuscript PDF */}
            <div
              className={`rounded-2xl border-2 border-dashed p-8 text-center transition-all cursor-pointer hover:shadow-lg ${manuscriptPdf ? 'border-violet-400 bg-violet-50' : 'border-gray-300 hover:border-violet-400 bg-white'}`}
              onClick={() => manuscriptRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-violet-500', 'bg-violet-50'); }}
              onDragLeave={e => { e.currentTarget.classList.remove('border-violet-500', 'bg-violet-50'); }}
              onDrop={e => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-violet-500', 'bg-violet-50');
                const file = e.dataTransfer.files[0];
                if (file) handleManuscriptFile(file);
              }}
            >
              <FileText size={40} className={`mx-auto mb-3 ${manuscriptPdf ? 'text-violet-500' : 'text-gray-300'}`} />
              <h3 className="font-bold text-gray-900 mb-1">① 原稿PDF</h3>
              <p className="text-sm text-gray-500 mb-3">編集対象の原稿をアップロード</p>
              {manuscriptPdf ? (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-100 text-violet-700 text-sm font-medium">
                  <CheckCircle2 size={14} /> {manuscriptPdf.file.name}
                </div>
              ) : (
                <p className="text-xs text-gray-400">クリックまたはドラッグ＆ドロップ</p>
              )}
              <input ref={manuscriptRef} type="file" accept=".pdf" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleManuscriptFile(f); e.target.value = ''; }} />
            </div>

            {/* Correction Instructions PDF */}
            <div
              className={`rounded-2xl border-2 border-dashed p-8 text-center transition-all cursor-pointer hover:shadow-lg ${correctionPdf ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-red-400 bg-white'}`}
              onClick={() => correctionRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-red-500', 'bg-red-50'); }}
              onDragLeave={e => { e.currentTarget.classList.remove('border-red-500', 'bg-red-50'); }}
              onDrop={e => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-red-500', 'bg-red-50');
                const file = e.dataTransfer.files[0];
                if (file) handleCorrectionFile(file);
              }}
            >
              <ClipboardList size={40} className={`mx-auto mb-3 ${correctionPdf ? 'text-red-500' : 'text-gray-300'}`} />
              <h3 className="font-bold text-gray-900 mb-1">② 修正指示PDF</h3>
              <p className="text-sm text-gray-500 mb-3">赤字校正・修正指示をアップロード</p>
              {correctionPdf ? (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-100 text-red-700 text-sm font-medium">
                  <CheckCircle2 size={14} /> {correctionPdf.file.name}
                </div>
              ) : (
                <p className="text-xs text-gray-400">クリックまたはドラッグ＆ドロップ</p>
              )}
              <input ref={correctionRef} type="file" accept=".pdf" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleCorrectionFile(f); e.target.value = ''; }} />
            </div>
          </div>

          {/* Google Drive buttons */}
          <div className="flex justify-center gap-3 mb-6">
            <button
              onClick={async () => {
                try { const f = await pickPdfFromDrive(); if (f) handleManuscriptFile(f); } catch (err: any) { flash(err.message, 'error'); }
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border-2 border-violet-300 text-violet-600 hover:bg-violet-50 transition-all"
            >
              <HardDrive size={16} /> 原稿をDriveから
            </button>
            <button
              onClick={async () => {
                try { const f = await pickPdfFromDrive(); if (f) handleCorrectionFile(f); } catch (err: any) { flash(err.message, 'error'); }
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border-2 border-red-300 text-red-600 hover:bg-red-50 transition-all"
            >
              <HardDrive size={16} /> 修正指示をDriveから
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex justify-center gap-4 mb-8">
            <button
              onClick={handleExtractCorrections}
              disabled={!correctionPdf || loading}
              className="px-8 py-3 rounded-xl text-[15px] font-bold flex items-center gap-3 text-white shadow-lg transition-all hover:opacity-90 disabled:opacity-40"
              style={{ background: C.gradientPrimary }}
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <ClipboardList size={18} />}
              修正指示を解析 → タスク表作成
            </button>
            <button
              onClick={handleSkipToEditor}
              disabled={!manuscriptPdf}
              className="px-8 py-3 rounded-xl text-[15px] font-bold flex items-center gap-3 border-2 transition-all hover:shadow-md disabled:opacity-40"
              style={{ borderColor: '#8b5cf6', color: '#8b5cf6' }}
            >
              <PenTool size={18} /> 原稿を直接編集
            </button>
          </div>

          {/* Template button */}
          {onTemplateDesigner && (
            <div className="pt-6 border-t border-gray-100 text-center">
              <button onClick={onTemplateDesigner}
                className="flex items-center gap-2 mx-auto px-6 py-3 rounded-xl text-[14px] font-semibold border-2 transition-all hover:shadow-md"
                style={{ borderColor: '#8b5cf6', color: '#8b5cf6' }}
              >
                <LayoutTemplate size={18} /> テンプレートを作成・編集
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════
     Phase 2: Task Table
     ════════════════════════════════════════════════════════════════ */
  if (phase === 'tasks') {
    return (
      <div className="flex-1 flex overflow-hidden" style={{ background: C.bg }}>
        {/* Left: Task table */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-6 py-4 bg-white border-b" style={{ borderColor: C.border }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button onClick={() => setPhase('upload')} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600">
                  <ArrowLeft size={14} />
                </button>
                <ClipboardList size={18} style={{ color: '#8b5cf6' }} />
                <h2 className="text-lg font-bold text-gray-900">修正タスク表</h2>
                <span className="text-sm text-gray-400">({tasks.length}件)</span>
              </div>
              <div className="flex items-center gap-3">
                {/* Progress */}
                <div className="flex items-center gap-2">
                  <div className="w-32 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: C.gradientPrimary }} />
                  </div>
                  <span className="text-xs font-medium text-gray-500">{doneCount}/{tasks.length}</span>
                </div>
                <button
                  onClick={() => { setPhase('editor'); }}
                  disabled={!manuscriptPdf}
                  className="px-4 py-2 rounded-lg text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-40 flex items-center gap-2"
                  style={{ background: C.gradientPrimary }}
                >
                  <PenTool size={14} /> 原稿を編集
                </button>
              </div>
            </div>

            {/* Category filter */}
            <div className="flex items-center gap-2 mt-3">
              <Filter size={13} className="text-gray-400" />
              <button onClick={() => setFilterCategory('all')}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${filterCategory === 'all' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                すべて
              </button>
              {Object.entries(CATEGORY_LABELS).map(([key, { label, color }]) => (
                <button key={key} onClick={() => setFilterCategory(key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${filterCategory === key ? 'text-white' : 'text-gray-500 hover:opacity-80'}`}
                  style={filterCategory === key ? { background: color } : { background: `${color}15`, color }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Task list */}
          <div className="flex-1 overflow-auto p-4">
            {filteredTasks.length === 0 ? (
              <div className="text-center text-gray-400 py-16">
                <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">該当するタスクがありません</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredTasks.map(task => {
                  const cat = CATEGORY_LABELS[task.category] || CATEGORY_LABELS.text;
                  const isExpanded = expandedTask === task.id;
                  return (
                    <div key={task.id}
                      className={`rounded-xl border bg-white transition-all hover:shadow-md ${task.status === 'done' ? 'opacity-60' : ''}`}
                      style={{ borderColor: C.border }}
                    >
                      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                        onClick={() => setExpandedTask(isExpanded ? null : task.id)}>
                        {/* Status toggle */}
                        <button onClick={e => { e.stopPropagation(); toggleTaskStatus(task.id); }}
                          className="shrink-0 transition-colors hover:scale-110">
                          {task.status === 'done'
                            ? <CheckCircle2 size={20} className="text-green-500" />
                            : <Circle size={20} className="text-gray-300 hover:text-violet-400" />}
                        </button>

                        {/* Priority */}
                        <span className="shrink-0">{PRIORITY_ICONS[task.priority]}</span>

                        {/* Category badge */}
                        <span className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold text-white" style={{ background: cat.color }}>
                          {cat.label}
                        </span>

                        {/* Page */}
                        <span className="shrink-0 text-xs text-gray-400 font-medium">P.{task.page}</span>

                        {/* Instruction */}
                        <span className={`flex-1 text-sm truncate ${task.status === 'done' ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                          {task.instruction}
                        </span>

                        {/* Location */}
                        <span className="shrink-0 text-xs text-gray-400">{task.location}</span>

                        {/* Expand */}
                        {isExpanded ? <ChevronUp size={14} className="text-gray-300" /> : <ChevronDown size={14} className="text-gray-300" />}
                      </div>

                      {isExpanded && (
                        <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: C.border }}>
                          {task.original_text && (
                            <div className="mb-2">
                              <span className="text-xs font-bold text-red-400">修正前:</span>
                              <p className="text-sm text-gray-600 bg-red-50 rounded-lg px-3 py-2 mt-1 line-through">{task.original_text}</p>
                            </div>
                          )}
                          {task.corrected_text && (
                            <div>
                              <span className="text-xs font-bold text-green-500">修正後:</span>
                              <p className="text-sm text-gray-800 bg-green-50 rounded-lg px-3 py-2 mt-1 font-medium">{task.corrected_text}</p>
                            </div>
                          )}
                          {!task.original_text && !task.corrected_text && (
                            <p className="text-sm text-gray-400 italic">詳細情報なし</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Correction PDF preview */}
        {correctionPreviews.length > 0 && (
          <div className="w-[400px] border-l overflow-auto bg-gray-50 flex flex-col" style={{ borderColor: C.border }}>
            <div className="px-4 py-3 bg-white border-b text-sm font-bold text-gray-700" style={{ borderColor: C.border }}>
              修正指示PDF プレビュー
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {correctionPreviews.map(p => (
                <div key={p.page_index} className="rounded-lg overflow-hidden border bg-white shadow-sm" style={{ borderColor: C.border }}>
                  <div className="px-3 py-1.5 border-b text-xs font-medium text-gray-400" style={{ borderColor: C.border }}>
                    ページ {p.page_index + 1}
                  </div>
                  <img src={`data:image/png;base64,${p.preview_b64}`} alt={`P${p.page_index + 1}`}
                    className="w-full" style={{ maxHeight: 600 }} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════
     Phase 3: pdfme Editor
     ════════════════════════════════════════════════════════════════ */
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: C.bg }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-3">
          <button onClick={() => tasks.length > 0 ? setPhase('tasks') : setPhase('upload')}
            className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors">
            <ArrowLeft size={14} /> {tasks.length > 0 ? 'タスク表' : 'アップロード'}
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <span className="text-sm text-gray-600 font-medium">
            <BookMarked size={14} className="inline mr-1" />
            商業出版 — PDF編集
          </span>
          {tasks.length > 0 && (
            <>
              <div className="w-px h-5 bg-gray-200" />
              <button onClick={() => setShowTaskPanel(!showTaskPanel)}
                className="flex items-center gap-1 text-xs font-medium text-violet-500 hover:text-violet-700 transition-colors">
                <ClipboardList size={13} />
                タスク {showTaskPanel ? '非表示' : '表示'} ({doneCount}/{tasks.length})
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportPdf}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white transition-all hover:opacity-90 shadow-md"
            style={{ background: C.gradientPrimary }}>
            <Download size={13} /> PDF出力
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden" style={{ minHeight: 0 }}>
        {/* pdfme Designer */}
        <div ref={designerRef} className="flex-1" style={{ minHeight: 0, height: '100%' }} />

        {/* Task sidebar */}
        {showTaskPanel && tasks.length > 0 && (
          <div className="w-[320px] border-l flex flex-col overflow-hidden bg-white" style={{ borderColor: C.border }}>
            <div className="px-3 py-2.5 border-b flex items-center justify-between" style={{ borderColor: C.border }}>
              <div className="flex items-center gap-2">
                <ClipboardList size={14} style={{ color: '#8b5cf6' }} />
                <span className="text-sm font-bold text-gray-800">修正タスク</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${progress}%`, background: '#8b5cf6' }} />
                </div>
                <span className="text-[10px] text-gray-400">{progress}%</span>
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {tasks.map(task => {
                const cat = CATEGORY_LABELS[task.category] || CATEGORY_LABELS.text;
                return (
                  <div key={task.id} className={`px-3 py-2 border-b flex items-start gap-2 hover:bg-gray-50 transition-colors ${task.status === 'done' ? 'opacity-50' : ''}`}
                    style={{ borderColor: C.border }}>
                    <button onClick={() => toggleTaskStatus(task.id)} className="shrink-0 mt-0.5">
                      {task.status === 'done'
                        ? <CheckCircle2 size={16} className="text-green-500" />
                        : <Circle size={16} className="text-gray-300 hover:text-violet-400" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold text-white" style={{ background: cat.color }}>{cat.label}</span>
                        <span className="text-[10px] text-gray-400">P.{task.page}</span>
                      </div>
                      <p className={`text-xs leading-relaxed ${task.status === 'done' ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                        {task.instruction}
                      </p>
                      {task.corrected_text && (
                        <p className="text-[10px] text-green-600 mt-0.5 font-medium truncate">→ {task.corrected_text}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CommercialPublishing;
