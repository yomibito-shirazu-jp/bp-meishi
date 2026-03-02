import React, { useState, useEffect, useRef } from 'react';
import { Span, CardProject, AppState } from './types';
import { analyzePdf, rebuildPdf } from './services/api';
import { listProjects, saveProject, deleteProject } from './services/supabase';
import {
  Upload, ArrowLeft, Plus, Trash2, Save, FileText, Eye, EyeOff,
  RefreshCw, Download, LayoutDashboard, FolderOpen, Settings,
  CreditCard, ChevronLeft,
} from 'lucide-react';

const FONT_LABELS: Record<string, string> = {
  gothic: 'ゴシック',
  mincho: '明朝',
  light: 'ライト',
  gothic_bold: 'ゴシック太',
};

const App: React.FC = () => {
  // Navigation
  const [view, setView] = useState<AppState>(AppState.DASHBOARD);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Dashboard
  const [projects, setProjects] = useState<CardProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'info' | 'ok' | 'error' } | null>(null);

  // Editor
  const [spans, setSpans] = useState<Span[]>([]);
  const [originalSpans, setOriginalSpans] = useState<Span[]>([]);
  const [pdfB64, setPdfB64] = useState<string | null>(null);
  const [pageMM, setPageMM] = useState<[number, number]>([91, 55]);
  const [originalPng, setOriginalPng] = useState<string | null>(null);
  const [rebuiltPng, setRebuiltPng] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'original' | 'rebuilt'>('original');
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);

  const fileRef = useRef<HTMLInputElement>(null);

  // ── Helpers ──
  const flash = (text: string, type: 'info' | 'ok' | 'error' = 'info') => {
    setToast({ text, type });
    if (type !== 'info') setTimeout(() => setToast(null), type === 'error' ? 6000 : 3000);
  };

  const selected = spans.find(s => s.id === selectedId) ?? null;

  const editCount = spans.filter((s, i) =>
    originalSpans[i] && s.text !== originalSpans[i].text
  ).length;

  const updateSpan = (id: string, updates: Partial<Span>) =>
    setSpans(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

  // ── Load projects ──
  const loadProjects = async () => {
    try {
      const data = await listProjects();
      setProjects(data);
    } catch (e: any) {
      console.error('Failed to load projects', e);
    }
  };

  useEffect(() => { loadProjects(); }, []);

  // ── Upload PDF ──
  const handleUpload = async (file: File) => {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      flash('PDFファイルを選択してください', 'error');
      return;
    }
    setLoading(true);
    flash('PDF分析中...', 'info');
    try {
      const data = await analyzePdf(file);
      setSpans(data.spans);
      setOriginalSpans(JSON.parse(JSON.stringify(data.spans)));
      setPdfB64(data.pdf_b64);
      setPageMM(data.page_mm);
      setOriginalPng(data.original_png_b64 ? `data:image/png;base64,${data.original_png_b64}` : null);
      setRebuiltPng(null);
      setSelectedId(null);
      setEditingProjectId(null);
      setViewTab('original');
      setView(AppState.EDIT);
      flash(`${data.spans.length}個のテキスト要素を検出`, 'ok');
    } catch (e: any) {
      flash(`分析エラー: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Rebuild ──
  const handleRebuild = async () => {
    if (!pdfB64) return;
    const edits: Record<string, string> = {};
    spans.forEach((s, i) => {
      if (originalSpans[i] && s.text !== originalSpans[i].text) edits[s.id] = s.text;
    });
    if (!Object.keys(edits).length) { flash('変更がありません', 'info'); return; }
    flash(`再構築中 (${Object.keys(edits).length}件)...`, 'info');
    try {
      const data = await rebuildPdf(pdfB64, edits);
      if (data.png_b64) setRebuiltPng(`data:image/png;base64,${data.png_b64}`);
      setViewTab('rebuilt');
      if (data.pdf_b64) {
        const a = document.createElement('a');
        a.href = `data:application/pdf;base64,${data.pdf_b64}`;
        const nameSpan = spans.find(s => s.font_class === 'mincho') || spans[0];
        a.download = `${nameSpan?.text?.trim() || '名刺'}.pdf`;
        a.click();
      }
      flash('PDF再構築完了', 'ok');
    } catch (e: any) {
      flash(`再構築エラー: ${e.message}`, 'error');
    }
  };

  // ── Save to Supabase ──
  const handleSave = async () => {
    const nameSpan = spans.find(s => s.font_class === 'mincho') || spans[0];
    const project: CardProject = {
      id: editingProjectId || crypto.randomUUID(),
      name: nameSpan?.text?.slice(0, 30) || '(無名)',
      spans,
      original_spans: originalSpans,
      pdf_b64: pdfB64 || '',
      page_mm: pageMM,
      original_png_b64: originalPng?.replace('data:image/png;base64,', '') ?? null,
      created_at: editingProjectId
        ? projects.find(p => p.id === editingProjectId)?.created_at || new Date().toISOString()
        : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      await saveProject(project);
      setEditingProjectId(project.id);
      await loadProjects();
      flash('保存しました', 'ok');
    } catch (e: any) {
      flash(`保存失敗: ${e.message}`, 'error');
    }
  };

  // ── Load project into editor ──
  const openProject = (p: CardProject) => {
    setSpans(p.spans);
    setOriginalSpans(p.original_spans ?? p.spans);
    setPdfB64(p.pdf_b64 || null);
    setPageMM(p.page_mm || [91, 55]);
    setOriginalPng(p.original_png_b64 ? `data:image/png;base64,${p.original_png_b64}` : null);
    setRebuiltPng(null);
    setSelectedId(null);
    setEditingProjectId(p.id);
    setViewTab('original');
    setView(AppState.EDIT);
  };

  // ── Delete project ──
  const handleDelete = async (id: string) => {
    try {
      await deleteProject(id);
      await loadProjects();
    } catch (e: any) {
      flash(`削除失敗: ${e.message}`, 'error');
    }
  };

  // ── Reset to dashboard ──
  const resetAll = () => {
    setView(AppState.DASHBOARD);
    setSpans([]);
    setOriginalSpans([]);
    setPdfB64(null);
    setOriginalPng(null);
    setRebuiltPng(null);
    setSelectedId(null);
    setEditingProjectId(null);
    loadProjects();
  };

  // ── Toast ──
  const renderToast = () => {
    if (!toast) return null;
    const colors = {
      ok: 'bg-emerald-900/90 border-emerald-700 text-emerald-100',
      error: 'bg-red-900/90 border-red-700 text-red-100',
      info: 'bg-slate-800/90 border-slate-600 text-slate-100',
    };
    return (
      <div className={`fixed top-4 right-4 z-[100] px-4 py-2.5 rounded-lg border text-sm font-medium flex items-center gap-2 shadow-xl backdrop-blur-sm ${colors[toast.type]}`}>
        {toast.type === 'info' && <div className="w-4 h-4 border-2 border-slate-400 border-t-white rounded-full animate-spin" />}
        {toast.text}
      </div>
    );
  };

  // ── Sidebar ──
  const sidebarItems = [
    { icon: LayoutDashboard, label: '名刺一覧', active: view === AppState.DASHBOARD, onClick: resetAll },
  ];

  const renderSidebar = () => (
    <div className={`${sidebarCollapsed ? 'w-16' : 'w-56'} bg-slate-900 text-white flex flex-col transition-all duration-200 shrink-0`}>
      {/* Logo */}
      <div className="px-4 py-5 flex items-center gap-3 border-b border-slate-700/50">
        <div className="w-8 h-8 rounded-lg bg-teal-500 flex items-center justify-center text-sm font-bold shrink-0">
          名
        </div>
        {!sidebarCollapsed && (
          <span className="text-sm font-bold tracking-tight">名刺マネージャー</span>
        )}
      </div>

      {/* Nav Items */}
      <nav className="flex-1 py-3 px-2 space-y-1">
        {sidebarItems.map(item => (
          <button
            key={item.label}
            onClick={item.onClick}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
              ${item.active
                ? 'bg-teal-500/20 text-teal-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
          >
            <item.icon size={18} className="shrink-0" />
            {!sidebarCollapsed && item.label}
          </button>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="px-2 pb-4">
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 text-xs transition-colors"
        >
          <ChevronLeft size={16} className={`transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`} />
          {!sidebarCollapsed && '折りたたむ'}
        </button>
      </div>
    </div>
  );

  // ── Header ──
  const renderHeader = () => (
    <div className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        {view === AppState.EDIT && (
          <button
            onClick={resetAll}
            className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 text-sm font-medium transition-colors"
          >
            <ArrowLeft size={16} />
            一覧へ戻る
          </button>
        )}
        {view === AppState.DASHBOARD && (
          <h2 className="text-base font-bold text-slate-800">名刺一覧</h2>
        )}
        {view === AppState.EDIT && (
          <div className="flex items-center gap-2">
            <CreditCard size={16} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-700">
              {editingProjectId ? '名刺編集' : '新規名刺'}
            </span>
            {editCount > 0 && (
              <span className="text-[11px] font-semibold text-teal-700 bg-teal-50 px-2 py-0.5 rounded-full border border-teal-200">
                {editCount}件変更
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {view === AppState.DASHBOARD && (
          <button
            onClick={() => fileRef.current?.click()}
            className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm"
          >
            <Plus size={16} />
            名刺PDFをアップロード
          </button>
        )}
        {view === AppState.EDIT && (
          <>
            <button
              onClick={handleSave}
              className="flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm font-medium px-3 py-2 rounded-lg hover:bg-slate-50 border border-slate-200 transition-colors"
            >
              <Save size={15} />
              保存
            </button>
            <button
              onClick={handleRebuild}
              className={`bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all shadow-sm ${editCount > 0 ? '' : 'opacity-40 cursor-not-allowed'}`}
            >
              <Download size={15} />
              再構築 & PDF出力
            </button>
          </>
        )}
      </div>
    </div>
  );

  // ── Dashboard Content ──
  const renderDashboardContent = () => (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto p-8">
        <input
          type="file"
          ref={fileRef}
          className="hidden"
          accept=".pdf,application/pdf"
          onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); e.target.value = ''; }}
        />

        {/* Loading overlay */}
        {loading && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin w-10 h-10 border-3 border-slate-300 border-t-slate-800 rounded-full mx-auto mb-4" />
              <p className="text-base font-medium text-slate-700">PDF分析中...</p>
              <p className="text-xs text-slate-400 mt-1">テキスト要素を抽出しています</p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {projects.length === 0 && !loading && (
          <div className="bg-white rounded-xl border border-dashed border-slate-300 p-12">
            <div
              className={`max-w-md mx-auto text-center cursor-pointer transition-all ${dragOver ? 'scale-[1.02]' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]); }}
            >
              <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-5">
                <Upload size={28} className="text-slate-400" />
              </div>
              <p className="text-lg font-bold text-slate-700">名刺PDFをアップロード</p>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                PDFをドラッグ&ドロップ、またはクリックして選択
              </p>
              <div className="mt-6 flex items-center justify-center gap-2">
                <span className="text-[11px] text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full font-medium">PDF</span>
                <span className="text-[11px] text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full font-medium">Cloud Run</span>
                <span className="text-[11px] text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full font-medium">Supabase</span>
              </div>
            </div>
          </div>
        )}

        {/* Project cards */}
        {projects.length > 0 && (
          <div className="space-y-4">
            {projects.map(p => (
              <div
                key={p.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all overflow-hidden cursor-pointer group"
                onClick={() => openProject(p)}
              >
                <div className="flex items-center gap-5 p-5">
                  {/* Thumbnail */}
                  <div className="w-28 h-16 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center overflow-hidden shrink-0">
                    {p.original_png_b64 ? (
                      <img
                        src={`data:image/png;base64,${p.original_png_b64}`}
                        alt={p.name}
                        className="w-full h-full object-contain p-1"
                      />
                    ) : (
                      <FileText size={20} className="text-slate-300" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-slate-800 text-base truncate">{p.name || '(無名)'}</h4>
                      <span className="text-[11px] font-medium text-teal-700 bg-teal-50 px-2 py-0.5 rounded-full border border-teal-200 shrink-0">
                        {p.spans?.length || 0}要素
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {new Date(p.created_at).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })}
                      {p.page_mm && ` · ${p.page_mm[0]}mm × ${p.page_mm[1]}mm`}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-700 transition-colors">
                      編集
                    </button>
                    <button
                      className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      onClick={e => { e.stopPropagation(); handleDelete(p.id); }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // ── Editor Content ──
  const renderEditorContent = () => (
    <div className="flex-1 flex overflow-hidden">
      {/* Left Panel: Span list */}
      <div className="w-80 bg-white border-r border-slate-200 flex flex-col z-10">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            テキスト要素 ({spans.length})
          </h3>
          <span className="text-[10px] text-slate-300 bg-slate-50 px-2 py-0.5 rounded font-mono">
            {pageMM[0]}×{pageMM[1]}mm
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="p-2 space-y-0.5">
            {spans.map((s, i) => {
              const changed = originalSpans[i] && s.text !== originalSpans[i].text;
              return (
                <div
                  key={s.id}
                  onClick={() => setSelectedId(selectedId === s.id ? null : s.id)}
                  className={`px-3 py-2 rounded-lg cursor-pointer text-sm transition-all
                    ${selectedId === s.id ? 'bg-teal-50 ring-1 ring-teal-200' : 'hover:bg-slate-50'}
                    ${changed ? 'border-r-[3px] border-teal-500' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400 shrink-0 bg-slate-100 px-1.5 py-0.5 rounded font-medium">
                      {FONT_LABELS[s.font_class] || s.font_class}
                    </span>
                    <span className="text-[10px] text-slate-300">{s.size_pt}pt</span>
                  </div>
                  <div className={`truncate mt-1 ${changed ? 'font-bold text-teal-700' : 'text-slate-700'}`}>
                    {s.text}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected span editor */}
        {selected && (
          <div className="border-t border-teal-100 bg-gradient-to-b from-teal-50/60 to-white p-4 space-y-3">
            <div className="text-xs font-bold text-teal-700">
              テキスト編集
            </div>
            <textarea
              rows={3}
              value={selected.text}
              onChange={e => updateSpan(selected.id, { text: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-200 focus:border-teal-300 resize-vertical bg-white"
            />
            {(() => {
              const orig = originalSpans.find(o => o.id === selected.id);
              return orig && orig.text !== selected.text ? (
                <div className="text-xs text-slate-400">
                  元: <span className="line-through">{orig.text}</span>
                </div>
              ) : null;
            })()}
            <div className="text-[10px] text-slate-400 bg-slate-50 rounded-lg p-2.5 font-mono">
              {selected.font_original} → {FONT_LABELS[selected.font_class] || selected.font_class} / {selected.size_pt}pt
            </div>
          </div>
        )}
      </div>

      {/* Center: Preview */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* View tabs */}
        <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center gap-2">
          <button
            onClick={() => setViewTab('original')}
            disabled={!originalPng}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors
              ${viewTab === 'original' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}
              ${!originalPng ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            <Eye size={14} />
            元画像
          </button>
          <button
            onClick={() => setViewTab('rebuilt')}
            disabled={!rebuiltPng}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors
              ${viewTab === 'rebuilt' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}
              ${!rebuiltPng ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            <RefreshCw size={14} />
            再構築
          </button>
          <div className="ml-auto">
            <button
              onClick={() => setShowOverlay(!showOverlay)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${showOverlay ? 'bg-teal-50 text-teal-700 border border-teal-200' : 'text-slate-400 hover:bg-slate-100'}`}
            >
              {showOverlay ? <Eye size={14} /> : <EyeOff size={14} />}
              オーバーレイ
            </button>
          </div>
        </div>

        {/* Image area with interactive overlay */}
        <div className="flex-1 bg-slate-100 flex items-center justify-center p-8 overflow-auto relative">
          <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{
            backgroundImage: 'conic-gradient(#64748b 25%, #f1f5f9 0 50%, #64748b 0 75%, #f1f5f9 0)',
            backgroundSize: '20px 20px'
          }} />
          {viewTab === 'rebuilt' && rebuiltPng ? (
            <img
              src={rebuiltPng}
              alt="再構築"
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            />
          ) : originalPng ? (
            <div
              className="relative rounded-lg shadow-2xl overflow-hidden bg-white"
              style={{ aspectRatio: `${pageMM[0]} / ${pageMM[1]}`, maxHeight: '80vh', maxWidth: '90%' }}
              onClick={() => setSelectedId(null)}
            >
              {/* Base image */}
              <img
                src={originalPng}
                alt="元画像"
                className="w-full h-full object-contain"
                draggable={false}
              />
              {/* Span overlay */}
              {showOverlay && spans.map((s, i) => {
                const isSelected = selectedId === s.id;
                const changed = originalSpans[i] && s.text !== originalSpans[i].text;
                return (
                  <div
                    key={s.id}
                    onClick={e => { e.stopPropagation(); setSelectedId(isSelected ? null : s.id); }}
                    title={`${s.text} (${FONT_LABELS[s.font_class] || s.font_class} ${s.size_pt}pt)`}
                    style={{
                      position: 'absolute',
                      left: `${s.x_pct}%`,
                      top: `${s.y_pct}%`,
                      width: `${s.w_pct}%`,
                      height: `${s.h_pct}%`,
                      cursor: 'pointer',
                      border: isSelected
                        ? '2px solid #0d9488'
                        : changed
                          ? '2px solid #8b5cf6'
                          : '1px solid transparent',
                      background: isSelected
                        ? 'rgba(13,148,136,0.12)'
                        : changed
                          ? 'rgba(139,92,246,0.10)'
                          : 'transparent',
                      borderRadius: '3px',
                      transition: 'all 0.1s',
                      zIndex: isSelected ? 20 : 10,
                    }}
                    className="hover:border-teal-300 hover:bg-teal-500/5"
                  >
                    {changed && (
                      <span
                        style={{
                          position: 'absolute',
                          top: '-1px',
                          left: '-1px',
                          right: '-1px',
                          bottom: '-1px',
                          display: 'flex',
                          alignItems: 'center',
                          background: 'rgba(255,255,255,0.88)',
                          color: '#7c3aed',
                          fontSize: `${Math.max(8, Math.min(14, s.size_pt * 0.8))}px`,
                          fontWeight: 600,
                          padding: '0 2px',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          borderRadius: '3px',
                        }}
                      >
                        {s.text}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-slate-400 text-sm">画像なし</div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {renderToast()}
      {renderSidebar()}
      <div className="flex-1 flex flex-col min-w-0">
        {renderHeader()}
        {view === AppState.DASHBOARD && renderDashboardContent()}
        {view === AppState.EDIT && renderEditorContent()}
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl p-8 shadow-2xl text-center">
            <div className="animate-spin w-10 h-10 border-3 border-slate-200 border-t-teal-500 rounded-full mx-auto mb-4" />
            <p className="text-base font-bold text-slate-700">PDF分析中...</p>
            <p className="text-xs text-slate-400 mt-1">テキスト要素を抽出しています</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
