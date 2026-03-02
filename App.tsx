import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Span, CardProject, AppState } from './types';
import { analyzePdf, rebuildPdf } from './services/api';
import { listProjects, saveProject, deleteProject } from './services/supabase';
import { correctOcrWithAI, CorrectedSpan } from './services/ai';
import {
  Upload, ArrowLeft, Plus, Trash2, Save, FileText, Eye, EyeOff,
  Download, LayoutDashboard, CreditCard, ChevronLeft,
  Search, Building2, Inbox, Sparkles, Loader,
} from 'lucide-react';

/* ═══════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════ */

const FONT_LABELS: Record<string, string> = {
  gothic: 'ゴシック',
  mincho: '明朝',
  light: 'ライト',
  gothic_bold: 'ゴシック太',
};

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  company:    { label: '会社名', color: '#2563eb' },
  company_en: { label: '会社名(英)', color: '#3b82f6' },
  department: { label: '部署', color: '#7c3aed' },
  title:      { label: '役職', color: '#9333ea' },
  name:       { label: '氏名', color: '#dc2626' },
  name_reading: { label: 'ふりがな', color: '#ef4444' },
  address:    { label: '住所', color: '#059669' },
  phone:      { label: '電話', color: '#0891b2' },
  fax:        { label: 'FAX', color: '#0e7490' },
  mobile:     { label: '携帯', color: '#06b6d4' },
  email:      { label: 'メール', color: '#d97706' },
  url:        { label: 'URL', color: '#ea580c' },
  slogan:     { label: 'スローガン', color: '#64748b' },
  other:      { label: 'その他', color: '#94a3b8' },
};

// Warm color palette (matching meeting-notes-ai design)
const C = {
  bg: '#f8f7f4',
  card: '#ffffff',
  surface: '#f0efeb',
  border: '#e5e3dd',
  text: '#1a1917',
  textSec: '#5c5a54',
  muted: '#9c9a93',
  accent: '#3b5998',
  accentBg: '#eef1f8',
  accentBorder: '#c5d3ef',
};

/* ═══════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════ */

const getCompanyName = (spans: Span[]): string => {
  if (!spans || spans.length === 0) return '未分類';
  const gothic = spans.filter(s => s.font_class === 'gothic' || s.font_class === 'gothic_bold');
  if (gothic.length > 0) {
    return [...gothic].sort((a, b) => b.size_pt - a.size_pt)[0].text.trim() || '未分類';
  }
  const nonMincho = spans.filter(s => s.font_class !== 'mincho');
  return nonMincho.length > 0 ? nonMincho[0].text.trim() || '未分類' : '未分類';
};

const isUnprocessed = (p: CardProject): boolean => {
  if (!p.original_spans || !p.spans || p.original_spans.length === 0) return true;
  return p.spans.every((s, i) => p.original_spans[i] && s.text === p.original_spans[i].text);
};

/* ═══════════════════════════════════════════
   App Component
   ═══════════════════════════════════════════ */

const App: React.FC = () => {
  // ── Navigation ──
  const [view, setView] = useState<AppState>(AppState.DASHBOARD);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── Dashboard ──
  const [projects, setProjects] = useState<CardProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'info' | 'ok' | 'error' } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // ── Editor ──
  const [spans, setSpans] = useState<Span[]>([]);
  const [originalSpans, setOriginalSpans] = useState<Span[]>([]);
  const [spanMapping, setSpanMapping] = useState<Record<string, string[]>>({});
  const [pdfB64, setPdfB64] = useState<string | null>(null);
  const [pageMM, setPageMM] = useState<[number, number]>([91, 55]);
  const [originalPng, setOriginalPng] = useState<string | null>(null);
  const [rebuiltPng, setRebuiltPng] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [fieldCategories, setFieldCategories] = useState<Record<string, string>>({});

  const fileRef = useRef<HTMLInputElement>(null);

  // ── Derived ──
  const flash = (text: string, type: 'info' | 'ok' | 'error' = 'info') => {
    setToast({ text, type });
    if (type !== 'info') setTimeout(() => setToast(null), type === 'error' ? 6000 : 3000);
  };

  const selectedSpan = spans.find(s => s.id === selectedId) ?? null;

  const editCount = spans.filter((s, i) =>
    originalSpans[i] && s.text !== originalSpans[i].text
  ).length;

  const updateSpan = (id: string, updates: Partial<Span>) =>
    setSpans(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

  // ── Filtered & Grouped ──
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase();
    return projects.filter(p => {
      const allText = (p.spans || []).map(s => s.text).join(' ').toLowerCase();
      return allText.includes(q) || (p.name || '').toLowerCase().includes(q);
    });
  }, [projects, searchQuery]);

  const groupedProjects = useMemo(() => {
    const groups: Record<string, CardProject[]> = {};
    filteredProjects.forEach(p => {
      const company = getCompanyName(p.spans || []);
      if (!groups[company]) groups[company] = [];
      groups[company].push(p);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'ja'));
  }, [filteredProjects]);

  const inboxProjects = useMemo(() => projects.filter(isUnprocessed), [projects]);

  // ── Load projects ──
  const loadProjects = async () => {
    try { setProjects(await listProjects()); }
    catch (e: any) { console.error('Failed to load projects', e); }
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
      // Backend already merges fragmented spans — use directly
      const mergedSpans = data.spans;
      setSpanMapping(data.raw_id_map || {});
      setPdfB64(data.pdf_b64);
      setPageMM(data.page_mm);
      setOriginalPng(data.original_png_b64 ? `data:image/png;base64,${data.original_png_b64}` : null);
      setRebuiltPng(null);
      setSelectedId(null);
      setEditingProjectId(null);

      // Step 2: AI correction (Gemini Vision → verify)
      if (data.original_png_b64) {
        flash('AI補正中 (Gemini Vision)...', 'info');
        try {
          const corrected = await correctOcrWithAI(data.original_png_b64, mergedSpans);
          // Apply corrections: match by ID, update text + store category
          const correctedMap = new Map(corrected.map(c => [c.id, c]));
          const aiSpans = mergedSpans
            .map(s => {
              const fix = correctedMap.get(s.id);
              return fix ? { ...s, text: fix.text } : s;
            })
            .filter(s => {
              // Remove spans whose ID is NOT in the corrected set (AI merged them away)
              return correctedMap.has(s.id) || !corrected.length;
            });
          // Store category info for display
          const cats: Record<string, string> = {};
          corrected.forEach(c => { cats[c.id] = c.category; });
          setFieldCategories(cats);

          const finalSpans = aiSpans.length > 0 ? aiSpans : mergedSpans;
          setSpans(finalSpans);
          setOriginalSpans(JSON.parse(JSON.stringify(finalSpans)));
          setView(AppState.EDIT);
          flash(`${finalSpans.length}個のフィールド (AI補正済み)`, 'ok');
        } catch (aiErr: any) {
          console.error('AI correction failed:', aiErr);
          // Fallback: use merged spans without AI
          setSpans(mergedSpans);
          setOriginalSpans(JSON.parse(JSON.stringify(mergedSpans)));
          setView(AppState.EDIT);
          flash(`${mergedSpans.length}個のフィールド (AI補正失敗 — OCR結果を使用)`, 'error');
        }
      } else {
        setSpans(mergedSpans);
        setOriginalSpans(JSON.parse(JSON.stringify(mergedSpans)));
        setView(AppState.EDIT);
        flash(`${mergedSpans.length}個のフィールドを検出`, 'ok');
      }
    } catch (e: any) {
      flash(`分析エラー: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Rebuild PDF ──
  const handleRebuild = async () => {
    if (!pdfB64) return;
    // edits keyed by merged span ID — backend maps to raw spans via raw_id_map
    const edits: Record<string, string> = {};
    spans.forEach((s, i) => {
      if (originalSpans[i] && s.text !== originalSpans[i].text) {
        edits[s.id] = s.text;
      }
    });
    if (!Object.keys(edits).length) { flash('変更がありません', 'info'); return; }
    flash(`再構築中 (${Object.keys(edits).length}件)...`, 'info');
    try {
      const data = await rebuildPdf(pdfB64, edits, spanMapping);
      if (data.png_b64) setRebuiltPng(`data:image/png;base64,${data.png_b64}`);
      if (data.pdf_b64) {
        const a = document.createElement('a');
        a.href = `data:application/pdf;base64,${data.pdf_b64}`;
        const nameSpan = spans.find(s => s.font_class === 'mincho') || spans[0];
        a.download = `${nameSpan?.text?.trim() || '名刺'}.pdf`;
        a.click();
      }
      flash('PDF再構築完了 — ダウンロードを開始しました', 'ok');
    } catch (e: any) {
      flash(`再構築エラー: ${e.message}`, 'error');
    }
  };

  // ── Save to storage ──
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

  // ── Open project ──
  const openProject = (p: CardProject) => {
    setSpans(p.spans || []);
    setOriginalSpans(p.original_spans || p.spans || []);
    setSpanMapping({});
    setPdfB64(p.pdf_b64 || null);
    setPageMM(p.page_mm || [91, 55]);
    setOriginalPng(p.original_png_b64 ? `data:image/png;base64,${p.original_png_b64}` : null);
    setRebuiltPng(null);
    setSelectedId(null);
    setEditingProjectId(p.id);
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
    setSpanMapping({});
    setFieldCategories({});
    setPdfB64(null);
    setOriginalPng(null);
    setRebuiltPng(null);
    setSelectedId(null);
    setEditingProjectId(null);
    loadProjects();
  };

  /* ═══════════════════════════════════════════
     Render Functions
     ═══════════════════════════════════════════ */

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
  const renderSidebar = () => {
    const items = [
      { icon: LayoutDashboard, label: '名刺一覧', badge: 0, state: AppState.DASHBOARD },
      { icon: Inbox, label: '受信トレイ', badge: inboxProjects.length, state: AppState.INBOX },
    ];
    return (
      <div
        className={`${sidebarCollapsed ? 'w-16' : 'w-56'} flex flex-col transition-all duration-200 shrink-0`}
        style={{ background: '#1e293b' }}
      >
        {/* Logo */}
        <div className="px-4 py-5 flex items-center gap-3 border-b border-slate-700/50">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 text-white"
            style={{ background: C.accent }}
          >
            B
          </div>
          {!sidebarCollapsed && (
            <span className="text-sm font-bold tracking-tight text-white leading-tight">
              BizCard Tracer
              <br />
              <span className="text-[10px] font-normal text-slate-400">& Print Gen</span>
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-1">
          {items.map(item => {
            const active = view === item.state || (item.state === AppState.DASHBOARD && view === AppState.EDIT);
            return (
              <button
                key={item.label}
                onClick={() => item.state === AppState.DASHBOARD ? resetAll() : setView(item.state)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                  ${active ? 'text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                style={active ? { background: 'rgba(59,89,152,0.25)', color: '#93b4f4' } : {}}
              >
                <item.icon size={18} className="shrink-0" />
                {!sidebarCollapsed && <span className="flex-1 text-left">{item.label}</span>}
                {!sidebarCollapsed && item.badge > 0 && (
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: C.accent, color: '#fff' }}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
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
  };

  // ── Header ──
  const renderHeader = () => (
    <div className="h-14 bg-white border-b px-6 flex items-center justify-between shrink-0" style={{ borderColor: C.border }}>
      <div className="flex items-center gap-4">
        {view === AppState.EDIT && (
          <button
            onClick={resetAll}
            className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 text-sm font-medium transition-colors"
          >
            <ArrowLeft size={16} /> 一覧へ戻る
          </button>
        )}
        {view === AppState.DASHBOARD && <h2 className="text-base font-bold text-slate-800">名刺一覧</h2>}
        {view === AppState.INBOX && <h2 className="text-base font-bold text-slate-800">受信トレイ</h2>}
        {view === AppState.EDIT && (
          <div className="flex items-center gap-2">
            <CreditCard size={16} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-700">
              {editingProjectId ? '名刺編集' : '新規名刺'}
            </span>
            {editCount > 0 && (
              <span
                className="text-[11px] font-semibold px-2 py-0.5 rounded-full border"
                style={{ color: C.accent, background: C.accentBg, borderColor: C.accentBorder }}
              >
                {editCount}件変更
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {(view === AppState.DASHBOARD || view === AppState.INBOX) && (
          <button
            onClick={() => fileRef.current?.click()}
            className="text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90"
            style={{ background: C.accent }}
          >
            <Plus size={16} /> 名刺PDFをアップロード
          </button>
        )}
        {view === AppState.EDIT && (
          <>
            <button
              onClick={handleSave}
              className="flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm font-medium px-3 py-2 rounded-lg hover:bg-slate-50 border transition-colors"
              style={{ borderColor: C.border }}
            >
              <Save size={15} /> 保存
            </button>
            <button
              onClick={handleRebuild}
              className={`text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all shadow-sm
                ${editCount > 0 ? 'hover:opacity-90' : 'opacity-40 cursor-not-allowed'}`}
              style={{ background: editCount > 0 ? C.accent : '#94a3b8' }}
            >
              <Download size={15} /> 再構築 & PDF出力
            </button>
          </>
        )}
      </div>
    </div>
  );

  // ── Project Card (shared between dashboard & inbox) ──
  const renderProjectCard = (p: CardProject) => (
    <div
      key={p.id}
      className="bg-white rounded-xl border shadow-sm hover:shadow-md transition-all overflow-hidden cursor-pointer group"
      style={{ borderColor: C.border }}
      onClick={() => openProject(p)}
    >
      <div className="flex items-center gap-5 p-5">
        {/* Thumbnail */}
        <div
          className="w-28 h-16 rounded-lg border flex items-center justify-center overflow-hidden shrink-0"
          style={{ background: C.surface, borderColor: C.border }}
        >
          {p.original_png_b64 ? (
            <img
              src={`data:image/png;base64,${p.original_png_b64}`}
              alt={p.name}
              className="w-full h-full object-contain p-1"
            />
          ) : (
            <FileText size={20} style={{ color: C.muted }} />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-bold text-slate-800 text-base truncate">{p.name || '(無名)'}</h4>
            <span
              className="text-[11px] font-medium px-2 py-0.5 rounded-full border shrink-0"
              style={{ color: C.accent, background: C.accentBg, borderColor: C.accentBorder }}
            >
              {p.spans?.length || 0}要素
            </span>
            {isUnprocessed(p) && (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 shrink-0">
                未処理
              </span>
            )}
          </div>
          <p className="text-xs mt-1" style={{ color: C.muted }}>
            {new Date(p.created_at).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })}
            {p.page_mm && ` · ${p.page_mm[0]}mm × ${p.page_mm[1]}mm`}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="px-4 py-2 text-white rounded-lg text-sm font-medium transition-colors hover:opacity-90"
            style={{ background: C.accent }}
          >
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
  );

  // ── Dashboard ──
  const renderDashboard = () => (
    <div className="flex-1 overflow-auto" style={{ background: C.bg }}>
      <div className="max-w-6xl mx-auto p-8">
        <input
          type="file"
          ref={fileRef}
          className="hidden"
          accept=".pdf,application/pdf"
          onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); e.target.value = ''; }}
        />

        {/* Search bar */}
        <div className="mb-6">
          <div className="relative max-w-lg">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: C.muted }} />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="会社名・名前・テキストで検索..."
              className="w-full pl-11 pr-4 py-2.5 rounded-xl border text-sm font-medium focus:outline-none focus:ring-2 bg-white"
              style={{ borderColor: C.border }}
            />
          </div>
        </div>

        {/* Loading overlay */}
        {loading && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin w-10 h-10 border-3 border-slate-300 rounded-full mx-auto mb-4" style={{ borderTopColor: C.accent }} />
              <p className="text-base font-medium text-slate-700">PDF分析中...</p>
              <p className="text-xs mt-1" style={{ color: C.muted }}>テキスト要素を抽出しています</p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {projects.length === 0 && !loading && (
          <div className="bg-white rounded-xl border border-dashed p-12" style={{ borderColor: '#d4d2cc' }}>
            <div
              className={`max-w-md mx-auto text-center cursor-pointer transition-all ${dragOver ? 'scale-[1.02]' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]); }}
            >
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5" style={{ background: C.surface }}>
                <Upload size={28} style={{ color: C.muted }} />
              </div>
              <p className="text-lg font-bold text-slate-700">名刺PDFをアップロード</p>
              <p className="text-sm mt-2 leading-relaxed" style={{ color: C.muted }}>
                PDFをドラッグ&ドロップ、またはクリックして選択
              </p>
              <div className="mt-6 flex items-center justify-center gap-2">
                <span className="text-[11px] px-2.5 py-1 rounded-full font-medium" style={{ background: C.surface, color: C.muted }}>PDF</span>
                <span className="text-[11px] px-2.5 py-1 rounded-full font-medium" style={{ background: C.surface, color: C.muted }}>Cloud Run</span>
                <span className="text-[11px] px-2.5 py-1 rounded-full font-medium" style={{ background: C.surface, color: C.muted }}>Supabase</span>
              </div>
            </div>
          </div>
        )}

        {/* Grouped project cards */}
        {filteredProjects.length > 0 && (
          <div className="space-y-8">
            {groupedProjects.map(([company, cards]) => (
              <div key={company}>
                <div className="flex items-center gap-2 mb-3">
                  <Building2 size={16} style={{ color: C.accent }} />
                  <h3 className="text-sm font-bold" style={{ color: C.accent }}>{company}</h3>
                  <span
                    className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                    style={{ background: C.accentBg, color: C.accent }}
                  >
                    {cards.length}件
                  </span>
                </div>
                <div className="space-y-3">
                  {cards.map(p => <React.Fragment key={p.id}>{renderProjectCard(p)}</React.Fragment>)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* No search results */}
        {filteredProjects.length === 0 && projects.length > 0 && searchQuery && (
          <div className="text-center py-12">
            <p className="text-sm" style={{ color: C.muted }}>「{searchQuery}」に一致する名刺が見つかりません</p>
          </div>
        )}
      </div>
    </div>
  );

  // ── Inbox ──
  const renderInbox = () => (
    <div className="flex-1 overflow-auto" style={{ background: C.bg }}>
      <div className="max-w-6xl mx-auto p-8">
        <input
          type="file"
          ref={fileRef}
          className="hidden"
          accept=".pdf,application/pdf"
          onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); e.target.value = ''; }}
        />

        {inboxProjects.length === 0 ? (
          <div className="bg-white rounded-xl border p-12 text-center" style={{ borderColor: C.border }}>
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5" style={{ background: C.accentBg }}>
              <Inbox size={28} style={{ color: C.accent }} />
            </div>
            <p className="text-lg font-bold text-slate-700">受信トレイは空です</p>
            <p className="text-sm mt-2" style={{ color: C.muted }}>
              新しくアップロードされた未処理の名刺がここに表示されます
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs font-medium mb-4" style={{ color: C.muted }}>
              未処理の名刺 — 編集してテンプレートとして保存しましょう
            </p>
            {inboxProjects.map(p => <React.Fragment key={p.id}>{renderProjectCard(p)}</React.Fragment>)}
          </div>
        )}
      </div>
    </div>
  );

  // ── Editor ──
  const renderEditor = () => (
    <div className="flex-1 flex overflow-hidden">
      {/* Left: Detected Fields Panel (warm design) */}
      <div className="w-72 flex flex-col shrink-0 border-r" style={{ background: C.bg, borderColor: C.border }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: C.border }}>
          <div className="flex items-center gap-2">
            <FileText size={14} style={{ color: C.accent }} />
            <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: C.accent }}>
              検出フィールド ({spans.length})
            </h3>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded" style={{ background: C.surface, color: C.muted }}>
            {pageMM[0]}×{pageMM[1]}mm
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {spans.map((s, i) => {
            const isActive = selectedId === s.id;
            const changed = originalSpans[i] && s.text !== originalSpans[i].text;
            return (
              <div
                key={s.id}
                onClick={() => setSelectedId(isActive ? null : s.id)}
                className="rounded-xl cursor-pointer transition-all border"
                style={{
                  background: isActive ? C.accentBg : C.card,
                  borderColor: isActive ? C.accent : changed ? '#8b5cf6' : C.border,
                  padding: '10px 12px',
                  boxShadow: isActive ? `0 2px 8px rgba(59,89,152,0.12)` : 'none',
                }}
              >
                <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                  {fieldCategories[s.id] && CATEGORY_LABELS[fieldCategories[s.id]] && (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded text-white"
                      style={{ background: CATEGORY_LABELS[fieldCategories[s.id]].color }}
                    >
                      {CATEGORY_LABELS[fieldCategories[s.id]].label}
                    </span>
                  )}
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                    style={{ background: C.surface, color: C.textSec }}
                  >
                    {FONT_LABELS[s.font_class] || s.font_class}
                  </span>
                  <span className="text-[10px]" style={{ color: C.muted }}>{s.size_pt}pt</span>
                  {changed && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 ml-auto">
                      変更
                    </span>
                  )}
                </div>
                <div
                  className={`text-sm truncate ${changed ? 'font-bold text-purple-700' : ''}`}
                  style={{ color: changed ? undefined : C.text }}
                >
                  {s.text}
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected span editor */}
        {selectedSpan && (
          <div className="border-t p-4 space-y-3" style={{ borderColor: C.border, background: C.accentBg }}>
            <div className="text-xs font-bold" style={{ color: C.accent }}>テキスト編集</div>
            <textarea
              rows={3}
              value={selectedSpan.text}
              onChange={e => updateSpan(selectedSpan.id, { text: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 resize-vertical bg-white"
              style={{ borderColor: C.border }}
            />
            {(() => {
              const orig = originalSpans.find(o => o.id === selectedSpan.id);
              return orig && orig.text !== selectedSpan.text ? (
                <div className="text-xs" style={{ color: C.muted }}>
                  元: <span className="line-through">{orig.text}</span>
                </div>
              ) : null;
            })()}
            <div className="text-[10px] rounded-lg p-2.5 font-mono" style={{ background: C.surface, color: C.textSec }}>
              {selectedSpan.font_original} → {FONT_LABELS[selectedSpan.font_class] || selectedSpan.font_class} / {selectedSpan.size_pt}pt
            </div>
          </div>
        )}
      </div>

      {/* Center: Preview (edited version) */}
      <div className="flex-1 flex flex-col overflow-hidden border-r" style={{ borderColor: C.border }}>
        <div className="px-4 py-2 border-b flex items-center justify-between" style={{ background: C.card, borderColor: C.border }}>
          <div className="flex items-center gap-2">
            <Eye size={14} style={{ color: C.accent }} />
            <span className="text-xs font-bold" style={{ color: C.accent }}>プレビュー</span>
            {rebuiltPng && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                再構築済
              </span>
            )}
          </div>
          <button
            onClick={() => setShowOverlay(!showOverlay)}
            className="px-2 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1 transition-colors border"
            style={{
              background: showOverlay ? C.accentBg : 'transparent',
              color: showOverlay ? C.accent : C.muted,
              borderColor: showOverlay ? C.accentBorder : C.border,
            }}
          >
            {showOverlay ? <Eye size={12} /> : <EyeOff size={12} />}
            オーバーレイ
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-6 overflow-auto" style={{ background: C.surface }}>
          {rebuiltPng ? (
            <img
              src={rebuiltPng}
              alt="再構築プレビュー"
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            />
          ) : originalPng ? (
            <div
              className="relative rounded-lg shadow-2xl overflow-hidden bg-white"
              style={{ aspectRatio: `${pageMM[0]} / ${pageMM[1]}`, maxHeight: '80vh', maxWidth: '95%' }}
              onClick={() => setSelectedId(null)}
            >
              <img src={originalPng} alt="プレビュー" className="w-full h-full object-contain" draggable={false} />
              {showOverlay && spans.map((s, i) => {
                const isActive = selectedId === s.id;
                const changed = originalSpans[i] && s.text !== originalSpans[i].text;
                return (
                  <div
                    key={s.id}
                    onClick={e => { e.stopPropagation(); setSelectedId(isActive ? null : s.id); }}
                    title={`${s.text} (${FONT_LABELS[s.font_class] || s.font_class} ${s.size_pt}pt)`}
                    style={{
                      position: 'absolute',
                      left: `${s.x_pct}%`,
                      top: `${s.y_pct}%`,
                      width: `${s.w_pct}%`,
                      height: `${s.h_pct}%`,
                      cursor: 'pointer',
                      border: isActive
                        ? `2px solid ${C.accent}`
                        : changed
                          ? '2px solid #8b5cf6'
                          : '1px solid transparent',
                      background: isActive
                        ? 'rgba(59,89,152,0.12)'
                        : changed
                          ? 'rgba(139,92,246,0.10)'
                          : 'transparent',
                      borderRadius: '3px',
                      transition: 'all 0.1s',
                      zIndex: isActive ? 20 : 10,
                    }}
                  >
                    {changed && (
                      <span
                        style={{
                          position: 'absolute',
                          inset: '-1px',
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
            <div className="text-sm" style={{ color: C.muted }}>プレビューなし</div>
          )}
        </div>
      </div>

      {/* Right: Original (untouched) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 border-b flex items-center gap-2" style={{ background: C.card, borderColor: C.border }}>
          <FileText size={14} style={{ color: C.muted }} />
          <span className="text-xs font-bold" style={{ color: C.textSec }}>オリジナル</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-6 overflow-auto" style={{ background: '#f5f4f0' }}>
          {originalPng ? (
            <img
              src={originalPng}
              alt="オリジナル"
              className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
            />
          ) : (
            <div className="text-sm" style={{ color: C.muted }}>オリジナル画像なし</div>
          )}
        </div>
      </div>
    </div>
  );

  /* ═══════════════════════════════════════════
     Main Render
     ═══════════════════════════════════════════ */

  return (
    <div className="h-screen flex text-slate-900 font-sans overflow-hidden" style={{ background: C.bg }}>
      {renderToast()}
      {renderSidebar()}
      <div className="flex-1 flex flex-col min-w-0">
        {renderHeader()}
        {view === AppState.DASHBOARD && renderDashboard()}
        {view === AppState.INBOX && renderInbox()}
        {view === AppState.EDIT && renderEditor()}
      </div>

      {/* Global loading overlay */}
      {loading && (
        <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl p-8 shadow-2xl text-center">
            <div
              className="animate-spin w-10 h-10 border-3 border-slate-200 rounded-full mx-auto mb-4"
              style={{ borderTopColor: C.accent }}
            />
            <p className="text-base font-bold text-slate-700">PDF分析中...</p>
            <p className="text-xs mt-1" style={{ color: C.muted }}>テキスト要素を抽出しています</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
