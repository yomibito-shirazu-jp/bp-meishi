import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Span, PageData, CardProject, AppState, TranscribeProject, AiResult } from './types';
import { analyzePdf, rebuildPdf, SpanOverride } from './services/api';
import { listProjects, saveProject, deleteProject } from './services/supabase';
import { correctOcrWithAI } from './services/ai';
import { runAgentInstruction, AgentMessage } from './services/agent';
import { pickPdfFromDrive, pickFileFromDrive, isDriveConfigured } from './services/gdrive';
import { getConfig, saveConfig, getAllOverrides, ConfigKey } from './services/config';
import {
  Upload, ArrowLeft, Plus, Trash2, Save, FileText, Eye, EyeOff,
  Download, LayoutDashboard, CreditCard, ChevronLeft,
  Search, Building2, Inbox, ZoomIn, ZoomOut, Maximize, Move,
  MessageSquare, Send, Bot, Sparkles, Wand2, HardDrive,
  Settings, CheckCircle2, XCircle, Key, RefreshCw,
  FileAudio, Clock, List,
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

// Teal theme (FXGT-inspired)
const C = {
  bg: '#f1f5f9',
  card: '#ffffff',
  surface: '#f8fafc',
  border: '#e2e8f0',
  text: '#0f172a',
  textSec: '#475569',
  muted: '#94a3b8',
  accent: '#0d9488',
  accentBg: '#f0fdfa',
  accentBorder: '#99f6e4',
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
  const [previewTab, setPreviewTab] = useState<'edit' | 'original' | 'rebuilt'>('edit');
  const [fieldCategories, setFieldCategories] = useState<Record<string, string>>({});

  // ── Multi-Page ──
  const [allPages, setAllPages] = useState<PageData[]>([]);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [currentClipRect, setCurrentClipRect] = useState<[number, number, number, number] | undefined>();

  // ── Zoom & Drag ──
  const [zoom, setZoom] = useState(1);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; origX: number; origY: number } | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewImgRef = useRef<HTMLDivElement>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  // ── AI Chat ──
  const [chatMessages, setChatMessages] = useState<AgentMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [showChatInEditor, setShowChatInEditor] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // ── Settings ──
  const [settingsDraft, setSettingsDraft] = useState<Partial<Record<ConfigKey, string>>>({});
  const [settingsTestStatus, setSettingsTestStatus] = useState<Partial<Record<ConfigKey, { ok: boolean; msg: string } | null>>>({});
  const [settingsTesting, setSettingsTesting] = useState<Partial<Record<ConfigKey, boolean>>>({});

  // ── Derived ──
  const flash = (text: string, type: 'info' | 'ok' | 'error' = 'info') => {
    setToast({ text, type });
    if (type !== 'info') setTimeout(() => setToast(null), type === 'error' ? 6000 : 3000);
  };

  const editCount = spans.filter((s, i) => {
    if (!originalSpans[i]) return false;
    const o = originalSpans[i];
    return s.text !== o.text || s.font_class !== o.font_class || s.size_pt !== o.size_pt
      || s.x_pct !== o.x_pct || s.y_pct !== o.y_pct;
  }).length;

  const updateSpan = (id: string, updates: Partial<Span>) => {
    setSpans(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
    if ('text' in updates || 'origin' in updates || 'font_class' in updates || 'size_pt' in updates) {
      setRebuiltPng(null);
      setPreviewTab('edit');
    }
  };

  // ── Zoom ──
  const zoomIn = () => setZoom(z => Math.min(z + 0.25, 4));
  const zoomOut = () => setZoom(z => Math.max(z - 0.25, 0.25));
  const zoomReset = () => setZoom(1);

  // ── Drag-to-move ──
  const handleOverlayMouseDown = useCallback((e: React.MouseEvent, spanId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const span = spans.find(s => s.id === spanId);
    if (!span) return;
    setSelectedId(spanId);
    setDraggingId(spanId);
    setDragStart({ x: e.clientX, y: e.clientY, origX: span.x_pct, origY: span.y_pct });
  }, [spans]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingId || !dragStart || !previewImgRef.current) return;
    const rect = previewImgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStart.x) / rect.width) * 100;
    const dy = ((e.clientY - dragStart.y) / rect.height) * 100;
    const span = spans.find(s => s.id === draggingId);
    if (!span) return;
    const newX = Math.max(0, Math.min(100 - span.w_pct, dragStart.origX + dx));
    const newY = Math.max(0, Math.min(100 - span.h_pct, dragStart.origY + dy));
    setSpans(prev => prev.map(s =>
      s.id === draggingId ? { ...s, x_pct: newX, y_pct: newY } : s
    ));
  }, [draggingId, dragStart, spans]);

  const handleMouseUp = useCallback(() => {
    if (draggingId) {
      // Recalculate origin from pct for backend
      const span = spans.find(s => s.id === draggingId);
      if (span) {
        const pageW = pageMM[0] / 25.4 * 72;
        const pageH = pageMM[1] / 25.4 * 72;
        const newOriginX = (span.x_pct / 100) * pageW;
        const newOriginY = ((span.y_pct + span.h_pct) / 100) * pageH;
        updateSpan(draggingId, {
          origin: [Math.round(newOriginX * 100) / 100, Math.round(newOriginY * 100) / 100] as [number, number],
        });
      }
    }
    setDraggingId(null);
    setDragStart(null);
  }, [draggingId, spans, pageMM]);

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

  // ── Load a specific page into the editor ──
  const loadPage = async (pages: PageData[], idx: number, skipAI = false) => {
    const page = pages[idx];
    if (!page) return;
    setCurrentPageIdx(idx);
    setCurrentPageIndex(page.page_index);
    setCurrentClipRect(page.clip_rect as [number, number, number, number] | undefined);

    const mergedSpans = page.spans;
    setSpanMapping(page.raw_id_map || {});
    setPageMM(page.page_mm);
    setOriginalPng(page.original_png_b64 ? `data:image/png;base64,${page.original_png_b64}` : null);
    setRebuiltPng(null);
    setSelectedId(null);
    setZoom(1);

    if (!skipAI && page.original_png_b64) {
      flash('AI補正中 (Gemini Vision)...', 'info');
      try {
        const corrected = await correctOcrWithAI(page.original_png_b64, mergedSpans);
        const correctedMap = new Map(corrected.map(c => [c.id, c]));
        const aiSpans = mergedSpans
          .map(s => {
            const fix = correctedMap.get(s.id);
            return fix ? { ...s, text: fix.text } : s;
          })
          .filter(s => correctedMap.has(s.id) || !corrected.length);
        const cats: Record<string, string> = {};
        corrected.forEach(c => { cats[c.id] = c.category; });
        setFieldCategories(cats);

        const finalSpans = aiSpans.length > 0 ? aiSpans : mergedSpans;
        setSpans(finalSpans);
        setOriginalSpans(JSON.parse(JSON.stringify(finalSpans)));
        flash(`${finalSpans.length}個のフィールド (AI補正済み)`, 'ok');
      } catch (aiErr: any) {
        console.error('AI correction failed:', aiErr);
        setSpans(mergedSpans);
        setOriginalSpans(JSON.parse(JSON.stringify(mergedSpans)));
        flash(`${mergedSpans.length}個のフィールド (AI補正失敗)`, 'error');
      }
    } else {
      setSpans(mergedSpans);
      setOriginalSpans(JSON.parse(JSON.stringify(mergedSpans)));
      flash(`${mergedSpans.length}個のフィールドを検出`, 'ok');
    }
  };

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
      const pages = data.pages;
      setAllPages(pages);
      setPdfB64(data.pdf_b64);
      setEditingProjectId(null);

      if (pages.length === 0) {
        flash('ページが見つかりませんでした', 'error');
        return;
      }

      // Load first page with AI correction
      await loadPage(pages, 0);
      setView(AppState.EDIT);

      if (pages.length > 1) {
        flash(`${pages.length}ページ検出 (${pages.filter(p => p.page_label).map(p => p.page_label).join('・') || 'ページ切替可'})`, 'ok');
      }
    } catch (e: any) {
      flash(`分析エラー: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Build project object for save ──
  const buildProject = (rebuiltPdfB64?: string, rebuiltPngB64?: string): CardProject => {
    const nameSpan = spans.find(s => s.font_class === 'mincho') || spans[0];
    return {
      id: editingProjectId || crypto.randomUUID(),
      name: nameSpan?.text?.slice(0, 30) || '(無名)',
      spans,
      original_spans: originalSpans,
      pdf_b64: pdfB64 || '',
      page_mm: pageMM,
      original_png_b64: originalPng?.replace('data:image/png;base64,', '') ?? null,
      rebuilt_pdf_b64: rebuiltPdfB64 || null,
      rebuilt_png_b64: rebuiltPngB64 || null,
      raw_id_map: spanMapping,
      page_index: currentPageIndex,
      clip_rect: currentClipRect,
      created_at: editingProjectId
        ? projects.find(p => p.id === editingProjectId)?.created_at || new Date().toISOString()
        : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  };

  // ── Rebuild PDF + auto-save ──
  const handleRebuild = async () => {
    if (!pdfB64) return;
    const edits: Record<string, string> = {};
    const ovMap: Record<string, SpanOverride> = {};
    spans.forEach((s, i) => {
      if (!originalSpans[i]) return;
      const orig = originalSpans[i];
      const textChanged = s.text !== orig.text;
      const fontChanged = s.font_class !== orig.font_class;
      const sizeChanged = s.size_pt !== orig.size_pt;
      const posChanged = s.x_pct !== orig.x_pct || s.y_pct !== orig.y_pct;
      if (textChanged) edits[s.id] = s.text;
      if (fontChanged || sizeChanged || posChanged) {
        const ov: SpanOverride = {};
        if (fontChanged) ov.font_class = s.font_class;
        if (sizeChanged) ov.size_pt = s.size_pt;
        if (posChanged) ov.origin = s.origin;
        ovMap[s.id] = ov;
      }
    });
    const totalChanges = Object.keys(edits).length + Object.keys(ovMap).length;
    if (!totalChanges) { flash('変更がありません', 'info'); return; }
    flash(`再構築中 (${totalChanges}件)...`, 'info');
    try {
      const data = await rebuildPdf(pdfB64, edits, spanMapping, 300, currentPageIndex, currentClipRect, ovMap);
      if (data.png_b64) { setRebuiltPng(`data:image/png;base64,${data.png_b64}`); setPreviewTab('rebuilt'); }

      // Auto-save to DB with rebuilt PDF
      const project = buildProject(data.pdf_b64, data.png_b64);
      await saveProject(project);
      setEditingProjectId(project.id);
      await loadProjects();

      // Download
      if (data.pdf_b64) {
        const a = document.createElement('a');
        a.href = `data:application/pdf;base64,${data.pdf_b64}`;
        const nameSpan = spans.find(s => s.font_class === 'mincho') || spans[0];
        a.download = `${nameSpan?.text?.trim() || '名刺'}.pdf`;
        a.click();
      }
      flash('再構築 + 保存完了', 'ok');
    } catch (e: any) {
      flash(`再構築エラー: ${e.message}`, 'error');
    }
  };

  // ── Save to storage (without rebuild) ──
  const handleSave = async () => {
    const project = buildProject();
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
    setAllPages([]);
    setCurrentPageIdx(0);
    setCurrentPageIndex(p.page_index ?? 0);
    setCurrentClipRect(p.clip_rect);
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
    setAllPages([]);
    setCurrentPageIdx(0);
    setCurrentPageIndex(0);
    setCurrentClipRect(undefined);
    loadProjects();
  };

  // ── AI Agent ──
  const handleAgentSend = async (message?: string) => {
    const text = message || chatInput.trim();
    if (!text || chatLoading) return;
    setChatInput('');

    const userMsg: AgentMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setChatMessages(prev => [...prev, userMsg]);
    setChatLoading(true);

    try {
      const imageB64 = originalPng?.replace('data:image/png;base64,', '') || null;
      const response = await runAgentInstruction(
        text,
        spans,
        pageMM,
        imageB64,
        chatMessages,
      );

      // Apply actions
      if (response.actions && response.actions.length > 0) {
        let updatedSpans = [...spans];
        for (const action of response.actions) {
          if (action.type === 'update_span' && action.spanId && action.updates) {
            updatedSpans = updatedSpans.map(s =>
              s.id === action.spanId ? { ...s, ...action.updates } : s
            );
          }
          if (action.type === 'update_style' && action.spanId && action.updates) {
            updatedSpans = updatedSpans.map(s =>
              s.id === action.spanId ? { ...s, ...action.updates } : s
            );
          }
          if (action.type === 'move_span' && action.spanId && action.updates) {
            updatedSpans = updatedSpans.map(s => {
              if (s.id !== action.spanId) return s;
              const newS = { ...s, ...action.updates };
              // Recalculate origin from pct for backend
              const pageW = pageMM[0] / 25.4 * 72;
              const pageH = pageMM[1] / 25.4 * 72;
              newS.origin = [
                Math.round(((newS.x_pct / 100) * pageW) * 100) / 100,
                Math.round((((newS.y_pct + newS.h_pct) / 100) * pageH) * 100) / 100,
              ] as [number, number];
              return newS;
            });
          }
          if (action.type === 'delete_span' && action.spanId) {
            updatedSpans = updatedSpans.filter(s => s.id !== action.spanId);
          }
          if (action.type === 'add_span' && action.updates) {
            const newSpan: Span = {
              id: `span_${Math.random().toString(36).substring(2, 9)}`,
              text: action.updates.text || 'テキスト',
              font_original: 'AI Generated',
              font_class: action.updates.font_class || 'gothic',
              size_pt: action.updates.size_pt || 12,
              bbox: [0, 0, 0, 0], // AI created, no bbox
              origin: [0, 0] as [number, number],
              x_pct: action.updates.x_pct || 10,
              y_pct: action.updates.y_pct || 10,
              w_pct: action.updates.w_pct || 20,
              h_pct: action.updates.h_pct || 5,
              ...action.updates,
            };
            
            // Recalculate origin if missing but pct is available
            const pageW = pageMM[0] / 25.4 * 72;
            const pageH = pageMM[1] / 25.4 * 72;
            newSpan.origin = [
              Math.round(((newSpan.x_pct / 100) * pageW) * 100) / 100,
              Math.round((((newSpan.y_pct + newSpan.h_pct) / 100) * pageH) * 100) / 100,
            ];
            
            updatedSpans.push(newSpan);
          }
        }
        setSpans(updatedSpans);
        setRebuiltPng(null);
        setPreviewTab('edit');
      }

      const assistantMsg: AgentMessage = {
        role: 'assistant',
        content: response.message,
        timestamp: new Date().toISOString(),
        actions: response.actions,
      };
      setChatMessages(prev => [...prev, assistantMsg]);

      // If we're in AI_CHAT mode and spans are loaded, switch to editor
      if (view === AppState.AI_CHAT && response.actions.length > 0) {
        setView(AppState.EDIT);
        setShowChatInEditor(true);
      }
    } catch (err: any) {
      const errorMsg: AgentMessage = {
        role: 'assistant',
        content: `エラーが発生しました: ${err.message}`,
        timestamp: new Date().toISOString(),
      };
      setChatMessages(prev => [...prev, errorMsg]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  };

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAgentSend();
    }
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
    const sections = [
      {
        title: '名刺アプリ',
        items: [
          { icon: LayoutDashboard, label: '一覧', badge: 0, state: AppState.DASHBOARD },
          { icon: Inbox, label: '受信', badge: inboxProjects.length, state: AppState.INBOX },
          { icon: Wand2, label: 'AI作成', badge: 0, state: AppState.AI_CHAT },
        ],
      },
      {
        title: '文字起こし',
        items: [
          { icon: List, label: '一覧', badge: 0, state: AppState.TRANSCRIBE_LIST },
          { icon: Clock, label: '履歴', badge: 0, state: AppState.TRANSCRIBE_HISTORY },
          { icon: FileAudio, label: 'AI作成', badge: 0, state: AppState.TRANSCRIBE_AI },
        ],
      },
    ];

    const isActive = (state: AppState) =>
      view === state
      || (state === AppState.DASHBOARD && view === AppState.EDIT)
      || (state === AppState.AI_CHAT && view === AppState.EDIT && showChatInEditor);

    return (
      <div
        className={`${sidebarCollapsed ? 'w-16' : 'w-56'} flex flex-col transition-all duration-200 shrink-0 border-r`}
        style={{ background: C.card, borderColor: C.border }}
      >
        {/* Logo */}
        <div className="px-4 py-5 flex items-center gap-3 border-b" style={{ borderColor: C.border }}>
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 text-white"
            style={{ background: C.accent }}
          >
            ア
          </div>
          {!sidebarCollapsed && (
            <span className="text-sm font-bold tracking-tight leading-tight" style={{ color: C.text }}>
              アプリ作成し太郎
            </span>
          )}
        </div>

        {/* Nav sections */}
        <nav className="flex-1 py-3 px-2 space-y-4 overflow-y-auto">
          {sections.map(section => (
            <div key={section.title}>
              {!sidebarCollapsed && (
                <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: C.muted }}>
                  {section.title}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map(item => {
                  const active = isActive(item.state);
                  return (
                    <button
                      key={`${section.title}-${item.label}`}
                      onClick={() => {
                        if (item.state === AppState.DASHBOARD) { resetAll(); setShowChatInEditor(false); }
                        else if (item.state === AppState.AI_CHAT) { setView(AppState.AI_CHAT); setShowChatInEditor(false); }
                        else setView(item.state);
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                      style={active
                        ? { background: C.accentBg, color: C.accent, borderLeft: `3px solid ${C.accent}` }
                        : { color: C.textSec, borderLeft: '3px solid transparent' }}
                    >
                      <item.icon size={18} className="shrink-0" />
                      {!sidebarCollapsed && <span className="flex-1 text-left">{item.label}</span>}
                      {!sidebarCollapsed && item.badge > 0 && (
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white"
                          style={{ background: C.accent }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Settings */}
        <div className="px-2 border-t pt-2" style={{ borderColor: C.border }}>
          <button
            onClick={() => setView(AppState.SETTINGS)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
            style={view === AppState.SETTINGS
              ? { background: C.accentBg, color: C.accent, borderLeft: `3px solid ${C.accent}` }
              : { color: C.textSec, borderLeft: '3px solid transparent' }}
          >
            <Settings size={18} className="shrink-0" />
            {!sidebarCollapsed && <span className="flex-1 text-left">設定</span>}
          </button>
        </div>

        {/* Collapse toggle */}
        <div className="px-2 pb-4">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors hover:bg-slate-50"
            style={{ color: C.muted }}
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
        {view === AppState.AI_CHAT && (
          <div className="flex items-center gap-2">
            <Sparkles size={16} style={{ color: C.accent }} />
            <h2 className="text-base font-bold text-slate-800">AI作成モード</h2>
          </div>
        )}
        {view === AppState.SETTINGS && (
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-slate-400" />
            <h2 className="text-base font-bold text-slate-800">設定</h2>
          </div>
        )}
        {view === AppState.TRANSCRIBE_LIST && <h2 className="text-base font-bold text-slate-800">文字起こし一覧</h2>}
        {view === AppState.TRANSCRIBE_HISTORY && <h2 className="text-base font-bold text-slate-800">文字起こし履歴</h2>}
        {view === AppState.TRANSCRIBE_AI && (
          <div className="flex items-center gap-2">
            <FileAudio size={16} style={{ color: C.accent }} />
            <h2 className="text-base font-bold text-slate-800">AI文字起こし</h2>
          </div>
        )}
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setView(AppState.AI_CHAT); setShowChatInEditor(false); }}
              className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90 border"
              style={{ background: 'linear-gradient(135deg, #0d9488, #06b6d4)', color: 'white' }}
            >
              <Wand2 size={16} /> AIで作成
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className="text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90"
              style={{ background: C.accent }}
            >
              <Plus size={16} /> PDFアップロード
            </button>
            {isDriveConfigured() && (
              <button
                onClick={async () => {
                  try {
                    const file = await pickPdfFromDrive();
                    if (file) handleUpload(file);
                  } catch (e: any) {
                    flash(e.message || 'Google Drive接続エラー', 'error');
                  }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90 border"
                style={{ borderColor: C.accentBorder, color: C.accent, background: C.accentBg }}
              >
                <HardDrive size={16} /> Google Drive
              </button>
            )}
          </div>
        )}
        {view === AppState.EDIT && (
          <>
            <button
              onClick={() => setShowChatInEditor(!showChatInEditor)}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border transition-colors"
              style={{
                borderColor: showChatInEditor ? C.accentBorder : C.border,
                background: showChatInEditor ? C.accentBg : 'transparent',
                color: showChatInEditor ? C.accent : C.textSec,
              }}
            >
              <MessageSquare size={15} /> AI指示
            </button>
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
          {p.rebuilt_pdf_b64 && (
            <button
              className="p-2 rounded-lg transition-colors hover:bg-teal-50"
              style={{ color: C.accent }}
              title="再構築PDFをダウンロード"
              onClick={e => {
                e.stopPropagation();
                const a = document.createElement('a');
                a.href = `data:application/pdf;base64,${p.rebuilt_pdf_b64}`;
                a.download = `${p.name || '名刺'}.pdf`;
                a.click();
              }}
            >
              <Download size={16} />
            </button>
          )}
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
              {isDriveConfigured() && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      const file = await pickPdfFromDrive();
                      if (file) handleUpload(file);
                    } catch (err: any) {
                      flash(err.message || 'Google Drive接続エラー', 'error');
                    }
                  }}
                  className="mt-4 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 mx-auto transition-colors hover:opacity-90 border"
                  style={{ borderColor: C.accentBorder, color: C.accent, background: C.accentBg }}
                >
                  <HardDrive size={16} /> Google Driveから選択
                </button>
              )}
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

  // ── Page switch handler ──
  const handlePageSwitch = async (idx: number) => {
    if (idx === currentPageIdx || !allPages[idx]) return;
    setLoading(true);
    try {
      await loadPage(allPages, idx);
    } finally {
      setLoading(false);
    }
  };

  // ── Editor ──
  const renderEditor = () => (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Page selector bar (only when multiple pages) */}
      {allPages.length > 1 && (
        <div className="px-4 py-2 border-b flex items-center justify-end gap-3 shrink-0" style={{ background: C.card, borderColor: C.border }}>
          <div className="flex items-center gap-1.5">
            {allPages.map((p, i) => (
              <button
                key={i}
                onClick={() => handlePageSwitch(i)}
                className="px-4 py-2 rounded-lg text-sm font-bold transition-all border-2"
                style={{
                  background: currentPageIdx === i ? C.accent : 'transparent',
                  color: currentPageIdx === i ? '#fff' : C.textSec,
                  borderColor: currentPageIdx === i ? C.accent : C.border,
                  boxShadow: currentPageIdx === i ? '0 2px 8px rgba(13,148,136,0.3)' : 'none',
                }}
              >
                {p.page_label || `ページ ${i + 1}`}
              </button>
            ))}
          </div>
          <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: C.accentBg, color: C.accent }}>
            {allPages.length}ページ
          </span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
      {/* Left: Fields Form + Property Panel */}
      <div className="w-96 flex flex-col shrink-0 border-r" style={{ background: C.bg, borderColor: C.border }}>
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

        <div className="flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ background: C.surface }}>
                <th className="text-left text-[10px] font-bold uppercase px-3 py-2 tracking-wider" style={{ color: C.muted, width: '80px' }}>フォント</th>
                <th className="text-left text-[10px] font-bold uppercase px-3 py-2 tracking-wider" style={{ color: C.muted }}>テキスト</th>
              </tr>
            </thead>
            <tbody>
              {spans.map((s, i) => {
                const isActive = selectedId === s.id;
                const changed = originalSpans[i] && s.text !== originalSpans[i].text;
                return (
                  <tr
                    key={s.id}
                    onClick={() => setSelectedId(isActive ? null : s.id)}
                    className="cursor-pointer"
                    style={{
                      background: isActive ? C.accentBg : i % 2 === 0 ? C.card : C.bg,
                      borderBottom: `1px solid ${C.border}`,
                    }}
                  >
                    <td className="px-3 py-2 align-top" style={{ width: '80px' }}>
                      <div className="flex flex-col gap-0.5">
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded inline-block text-center"
                          style={{ background: C.surface, color: C.textSec }}
                        >
                          {FONT_LABELS[s.font_class] || s.font_class}
                        </span>
                        <span className="text-[9px] text-center" style={{ color: C.muted }}>{s.size_pt}pt</span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        type="text"
                        value={s.text}
                        onChange={e => updateSpan(s.id, { text: e.target.value })}
                        onFocus={() => setSelectedId(s.id)}
                        className="w-full px-2 py-1.5 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-teal-300 bg-white"
                        style={{
                          borderColor: changed ? C.accent : C.border,
                          color: changed ? C.accent : C.text,
                          fontWeight: changed ? 600 : 400,
                        }}
                      />
                      {changed && originalSpans[i] && (
                        <div className="text-[10px] mt-0.5 truncate" style={{ color: C.muted }}>
                          <span className="line-through">{originalSpans[i].text}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Property Panel — shown when a span is selected */}
        {selectedId && (() => {
          const sel = spans.find(s => s.id === selectedId);
          if (!sel) return null;
          return (
            <div className="border-t px-4 py-3 space-y-3 shrink-0" style={{ borderColor: C.border, background: C.card }}>
              <div className="flex items-center justify-between">
                <h4 className="text-[11px] font-bold uppercase tracking-wider" style={{ color: C.accent }}>
                  プロパティ
                </h4>
                <span className="text-[10px] font-mono" style={{ color: C.muted }}>{sel.id}</span>
              </div>
              {/* Font family */}
              <div>
                <label className="text-[10px] font-semibold block mb-1" style={{ color: C.textSec }}>フォント</label>
                <select
                  value={sel.font_class}
                  onChange={e => updateSpan(sel.id, { font_class: e.target.value as Span['font_class'] })}
                  className="w-full px-2 py-1.5 border rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-300"
                  style={{ borderColor: C.border }}
                >
                  <option value="gothic">ゴシック (Noto Sans JP)</option>
                  <option value="mincho">明朝 (Noto Serif JP)</option>
                  <option value="light">ライト</option>
                  <option value="gothic_bold">ゴシック太</option>
                </select>
              </div>
              {/* Font size */}
              <div>
                <label className="text-[10px] font-semibold block mb-1" style={{ color: C.textSec }}>サイズ (pt)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={sel.size_pt}
                    onChange={e => updateSpan(sel.id, { size_pt: parseFloat(e.target.value) || sel.size_pt })}
                    step={0.5}
                    min={1}
                    max={120}
                    className="w-20 px-2 py-1.5 border rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-300"
                    style={{ borderColor: C.border }}
                  />
                  <div className="flex gap-1">
                    {[6, 8, 9, 10, 12, 14, 18, 24].map(sz => (
                      <button
                        key={sz}
                        onClick={() => updateSpan(sel.id, { size_pt: sz })}
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors"
                        style={{
                          borderColor: sel.size_pt === sz ? C.accent : C.border,
                          background: sel.size_pt === sz ? C.accentBg : 'transparent',
                          color: sel.size_pt === sz ? C.accent : C.muted,
                        }}
                      >
                        {sz}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {/* Position */}
              <div>
                <label className="text-[10px] font-semibold block mb-1" style={{ color: C.textSec }}>
                  位置 <Move size={10} className="inline ml-0.5" style={{ color: C.muted }} />
                </label>
                <div className="flex gap-2 text-[10px]" style={{ color: C.muted }}>
                  <span>X: {sel.x_pct.toFixed(1)}%</span>
                  <span>Y: {sel.y_pct.toFixed(1)}%</span>
                  <span>W: {sel.w_pct.toFixed(1)}%</span>
                  <span>H: {sel.h_pct.toFixed(1)}%</span>
                </div>
                <p className="text-[9px] mt-1" style={{ color: C.muted }}>
                  プレビュー上でドラッグして移動可能
                </p>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Preview — 3-tab panel with zoom */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 border-b flex items-center justify-between" style={{ background: C.card, borderColor: C.border }}>
          <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: C.surface }}>
            {([
              { key: 'edit' as const, label: 'プレビュー' },
              { key: 'original' as const, label: 'オリジナル' },
              ...(rebuiltPng ? [{ key: 'rebuilt' as const, label: '再構築済' }] : []),
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setPreviewTab(tab.key)}
                className="px-3 py-1.5 rounded-md text-xs font-bold transition-all"
                style={{
                  background: previewTab === tab.key ? C.card : 'transparent',
                  color: previewTab === tab.key
                    ? tab.key === 'rebuilt' ? '#059669' : C.accent
                    : C.muted,
                  boxShadow: previewTab === tab.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                }}
              >
                {tab.label}
              </button>
            ))}
            {editCount > 0 && previewTab === 'edit' && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full ml-1"
                style={{ background: C.accentBg, color: C.accent, border: `1px solid ${C.accentBorder}` }}>
                {editCount}件変更中
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Zoom controls */}
            <div className="flex items-center gap-1 border rounded-lg px-1" style={{ borderColor: C.border }}>
              <button onClick={zoomOut} className="p-1 rounded hover:bg-slate-50 transition-colors" style={{ color: C.muted }}>
                <ZoomOut size={14} />
              </button>
              <button
                onClick={zoomReset}
                className="px-1.5 py-0.5 text-[10px] font-mono font-bold rounded hover:bg-slate-50 transition-colors"
                style={{ color: C.textSec }}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button onClick={zoomIn} className="p-1 rounded hover:bg-slate-50 transition-colors" style={{ color: C.muted }}>
                <ZoomIn size={14} />
              </button>
              <button onClick={zoomReset} className="p-1 rounded hover:bg-slate-50 transition-colors" title="リセット" style={{ color: C.muted }}>
                <Maximize size={14} />
              </button>
            </div>
            {previewTab === 'edit' && (
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
            )}
          </div>
        </div>
        <div
          ref={previewContainerRef}
          className="flex-1 overflow-auto"
          style={{ background: C.surface }}
          onMouseMove={draggingId ? handleMouseMove : undefined}
          onMouseUp={draggingId ? handleMouseUp : undefined}
          onMouseLeave={draggingId ? handleMouseUp : undefined}
        >
          <div className="min-h-full flex items-center justify-center p-6">
          {previewTab === 'rebuilt' && rebuiltPng ? (
            <img
              src={rebuiltPng}
              alt="再構築プレビュー"
              className="object-contain rounded-lg shadow-2xl"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: draggingId ? 'none' : 'transform 0.2s' }}
            />
          ) : previewTab === 'edit' ? (
            originalPng ? (
              <div
                ref={previewImgRef}
                className="relative rounded-lg shadow-2xl overflow-visible bg-white"
                style={{
                  aspectRatio: `${pageMM[0]} / ${pageMM[1]}`,
                  maxHeight: `${85 * zoom}vh`,
                  maxWidth: `${95 * zoom}%`,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'center center',
                  transition: draggingId ? 'none' : 'transform 0.2s',
                }}
                onClick={() => { if (!draggingId) setSelectedId(null); }}
              >
                <img src={originalPng} alt="プレビュー" className="w-full h-full object-contain" draggable={false} />
                {showOverlay && spans.map((s, i) => {
                  const isActive = selectedId === s.id;
                  const isDragging = draggingId === s.id;
                  const changed = originalSpans[i] && s.text !== originalSpans[i].text;
                  const posChanged = originalSpans[i] && (s.x_pct !== originalSpans[i].x_pct || s.y_pct !== originalSpans[i].y_pct);
                  const isModified = changed || posChanged;
                  return (
                    <div
                      key={s.id}
                      onMouseDown={e => handleOverlayMouseDown(e, s.id)}
                      onClick={e => { e.stopPropagation(); if (!draggingId) setSelectedId(isActive ? null : s.id); }}
                      title={`${s.text} (${FONT_LABELS[s.font_class] || s.font_class} ${s.size_pt}pt)\nドラッグで移動`}
                      style={{
                        position: 'absolute',
                        left: `${s.x_pct}%`,
                        top: `${s.y_pct}%`,
                        width: `${s.w_pct}%`,
                        height: `${s.h_pct}%`,
                        cursor: isDragging ? 'grabbing' : 'grab',
                        border: isActive
                          ? `2px solid ${C.accent}`
                          : isModified
                            ? `2px solid ${C.accent}`
                            : `1px solid rgba(13,148,136,0.25)`,
                        background: isDragging
                          ? 'rgba(13,148,136,0.2)'
                          : isActive
                            ? 'rgba(13,148,136,0.12)'
                            : isModified
                              ? 'rgba(13,148,136,0.08)'
                              : 'rgba(13,148,136,0.04)',
                        borderRadius: '3px',
                        transition: isDragging ? 'none' : 'all 0.1s',
                        zIndex: isDragging ? 30 : isActive ? 20 : 10,
                        display: 'flex',
                        alignItems: 'center',
                        overflow: 'hidden',
                        userSelect: 'none',
                      }}
                    >
                      {isModified && (
                        <span style={{
                          background: 'rgba(255,255,255,0.92)',
                          color: C.accent,
                          fontWeight: 600,
                          fontSize: `max(9px, ${s.h_pct * 0.75}vh)`,
                          whiteSpace: 'nowrap',
                          padding: '0 2px',
                          lineHeight: 1,
                          width: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {s.text}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm" style={{ color: C.muted }}>プレビューなし</div>
            )
          ) : (
            /* Original tab */
            originalPng ? (
              <img
                src={originalPng}
                alt="オリジナル"
                className="object-contain rounded-lg shadow-2xl"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: 'transform 0.2s' }}
              />
            ) : (
              <div className="text-sm" style={{ color: C.muted }}>オリジナル画像なし</div>
            )
          )}
          </div>
        </div>
      </div>
    </div>
    </div>
  );

  // ── Chat Panel Component (reusable) ──
  const renderChatPanel = (isStandalone = false) => (
    <div
      className={`flex flex-col ${isStandalone ? 'flex-1' : 'w-[380px] shrink-0 border-l'}`}
      style={{ background: C.card, borderColor: C.border }}
    >
      {/* Chat Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between shrink-0" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #0d9488, #06b6d4)' }}
          >
            <Bot size={14} className="text-white" />
          </div>
          <div>
            <h3 className="text-xs font-bold" style={{ color: C.text }}>AI エージェント</h3>
            <p className="text-[10px]" style={{ color: C.muted }}>
              {chatLoading ? '考え中...' : '自然言語で名刺を編集'}
            </p>
          </div>
        </div>
        {chatMessages.length > 0 && (
          <button
            onClick={() => setChatMessages([])}
            className="text-[10px] px-2 py-1 rounded-md hover:bg-slate-50 transition-colors"
            style={{ color: C.muted }}
          >
            クリア
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {chatMessages.length === 0 && (
          <div className="text-center py-8">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: 'linear-gradient(135deg, rgba(13,148,136,0.1), rgba(6,182,212,0.1))' }}
            >
              <Sparkles size={24} style={{ color: C.accent }} />
            </div>
            <p className="text-sm font-bold mb-2" style={{ color: C.text }}>何をしましょうか？</p>
            <p className="text-xs leading-relaxed mb-4" style={{ color: C.muted }}>
              自然言語で名刺の編集を指示できます
            </p>
            <div className="space-y-2">
              {[
                '電話番号を 03-1234-5678 に変更して',
                '名前のフォントを明朝体にして',
                '会社名のサイズを大きくして',
                'メールアドレスを更新して',
              ].map((hint, i) => (
                <button
                  key={i}
                  onClick={() => handleAgentSend(hint)}
                  className="block w-full text-left px-3 py-2 rounded-lg text-xs transition-all hover:scale-[1.01] border"
                  style={{
                    background: C.surface,
                    color: C.textSec,
                    borderColor: C.border,
                  }}
                >
                  <span style={{ color: C.accent }}>→</span> {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {chatMessages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'rounded-br-md'
                  : 'rounded-bl-md'
              }`}
              style={{
                background: msg.role === 'user'
                  ? 'linear-gradient(135deg, #0d9488, #0f766e)'
                  : C.surface,
                color: msg.role === 'user' ? 'white' : C.text,
                border: msg.role === 'user' ? 'none' : `1px solid ${C.border}`,
              }}
            >
              {msg.role === 'assistant' && (
                <div className="flex items-center gap-1.5 mb-1">
                  <Bot size={12} style={{ color: C.accent }} />
                  <span className="text-[10px] font-bold" style={{ color: C.accent }}>AI</span>
                </div>
              )}
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.actions && msg.actions.length > 0 && (
                <div className="mt-2 pt-2 space-y-1" style={{ borderTop: `1px solid ${C.border}` }}>
                  {msg.actions.map((action, j) => (
                    <div
                      key={j}
                      className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md"
                      style={{ background: C.accentBg, color: C.accent }}
                    >
                      <Sparkles size={10} />
                      <span>{action.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {chatLoading && (
          <div className="flex justify-start">
            <div
              className="px-4 py-3 rounded-xl rounded-bl-md"
              style={{ background: C.surface, border: `1px solid ${C.border}` }}
            >
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: C.accent, animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: C.accent, animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: C.accent, animationDelay: '300ms' }} />
                </div>
                <span className="text-[11px]" style={{ color: C.muted }}>解析中...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-3 border-t shrink-0" style={{ borderColor: C.border }}>
        <div className="flex items-end gap-2">
          <textarea
            ref={chatInputRef}
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={handleChatKeyDown}
            placeholder="名刺の編集指示を入力..."
            rows={1}
            className="flex-1 px-3 py-2 border rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-teal-300 bg-white"
            style={{
              borderColor: C.border,
              minHeight: '38px',
              maxHeight: '100px',
            }}
          />
          <button
            onClick={() => handleAgentSend()}
            disabled={!chatInput.trim() || chatLoading}
            className="p-2.5 rounded-xl text-white transition-all shrink-0"
            style={{
              background: chatInput.trim() && !chatLoading
                ? 'linear-gradient(135deg, #0d9488, #06b6d4)'
                : '#cbd5e1',
              opacity: chatInput.trim() && !chatLoading ? 1 : 0.5,
            }}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  // ── AI Chat Standalone View ──
  const renderAIChat = () => (
    <div className="flex-1 flex overflow-hidden" style={{ background: C.bg }}>
      <div className="max-w-2xl mx-auto flex flex-col w-full">
        {renderChatPanel(true)}
      </div>
    </div>
  );

  // ── Settings ──
  const renderSettings = () => {
    type FieldDef = {
      key: ConfigKey;
      label: string;
      description: string;
      placeholder: string;
      sensitive: boolean;
      testFn?: () => Promise<string>;
    };

    const fields: FieldDef[] = [
      {
        key: 'VITE_API_URL',
        label: 'バックエンド API URL',
        description: 'Cloud Run などにデプロイされた Python バックエンドの URL',
        placeholder: 'https://example.run.app',
        sensitive: false,
        testFn: async () => {
          const url = (settingsDraft['VITE_API_URL'] ?? getConfig('VITE_API_URL')).replace(/\/$/, '');
          if (!url) throw new Error('URL を入力してください');
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) });
          if (!res.ok) throw new Error(`HTTP ${res.status} — サーバーが応答しましたが /health が失敗しました`);
          return 'APIサーバー接続成功 ✓';
        },
      },
      {
        key: 'VITE_SUPABASE_URL',
        label: 'Supabase URL',
        description: 'Supabase プロジェクトの Project URL（https://xxxx.supabase.co）',
        placeholder: 'https://xxxx.supabase.co',
        sensitive: false,
      },
      {
        key: 'VITE_SUPABASE_ANON_KEY',
        label: 'Supabase Anon Key',
        description: 'Supabase の anon/public API キー（URL と合わせてテストします）',
        placeholder: 'eyJhbGci...',
        sensitive: true,
        testFn: async () => {
          const url = settingsDraft['VITE_SUPABASE_URL'] ?? getConfig('VITE_SUPABASE_URL');
          const key = settingsDraft['VITE_SUPABASE_ANON_KEY'] ?? getConfig('VITE_SUPABASE_ANON_KEY');
          if (!url || !key) throw new Error('Supabase URL と Anon Key の両方を入力してください');
          const res = await fetch(`${url}/rest/v1/card_projects?select=id&limit=1`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(6000),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `HTTP ${res.status}`);
          }
          return 'Supabase 接続成功 ✓';
        },
      },
      {
        key: 'VITE_GOOGLE_AI_KEY',
        label: 'Google AI API Key (Gemini)',
        description: 'Google AI Studio で発行した API キー',
        placeholder: 'AIzaSy...',
        sensitive: true,
        testFn: async () => {
          const apiKey = settingsDraft['VITE_GOOGLE_AI_KEY'] ?? getConfig('VITE_GOOGLE_AI_KEY');
          if (!apiKey) throw new Error('API キーを入力してください');
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: 'Hi' }] }],
                generationConfig: { maxOutputTokens: 5 },
              }),
              signal: AbortSignal.timeout(10000),
            },
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
          }
          return 'Gemini API 接続成功 ✓';
        },
      },
    ];

    const handleTest = async (key: ConfigKey, testFn: () => Promise<string>) => {
      setSettingsTesting(prev => ({ ...prev, [key]: true }));
      setSettingsTestStatus(prev => ({ ...prev, [key]: null }));
      try {
        const msg = await testFn();
        setSettingsTestStatus(prev => ({ ...prev, [key]: { ok: true, msg } }));
      } catch (err: any) {
        setSettingsTestStatus(prev => ({ ...prev, [key]: { ok: false, msg: err.message } }));
      } finally {
        setSettingsTesting(prev => ({ ...prev, [key]: false }));
      }
    };

    const hasDraft = Object.keys(settingsDraft).some(k => settingsDraft[k as ConfigKey] !== '');

    const handleSaveAll = () => {
      Object.entries(settingsDraft).forEach(([k, v]) => {
        if (v !== undefined) saveConfig(k as ConfigKey, v);
      });
      setSettingsDraft({});
      setSettingsTestStatus({});
      flash('設定を保存しました', 'ok');
    };

    return (
      <div className="flex-1 overflow-auto" style={{ background: C.bg }}>
        <div className="max-w-2xl mx-auto p-8">
          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div>
              <h2 className="text-xl font-bold text-slate-800">設定</h2>
              <p className="text-sm mt-1" style={{ color: C.muted }}>
                APIキーを設定します。入力値は localStorage に保存され .env より優先されます。
              </p>
            </div>
            {hasDraft && (
              <button
                onClick={handleSaveAll}
                className="shrink-0 px-5 py-2.5 rounded-xl text-white text-sm font-bold flex items-center gap-2 shadow-sm hover:opacity-90 transition-all"
                style={{ background: C.accent }}
              >
                <Save size={15} /> すべて保存
              </button>
            )}
          </div>

          <div className="space-y-4">
            {fields.map(({ key, label, description, placeholder, sensitive, testFn }) => {
              const draftVal = settingsDraft[key] ?? '';
              const savedVal = getConfig(key);
              const isOverridden = getAllOverrides()[key] !== undefined;
              const testStatus = settingsTestStatus[key];
              const isTesting = settingsTesting[key] || false;
              const hasValue = draftVal !== '' || savedVal !== '';

              return (
                <div
                  key={key}
                  className="bg-white rounded-2xl border p-5 space-y-3 transition-shadow hover:shadow-sm"
                  style={{ borderColor: draftVal ? C.accentBorder : C.border }}
                >
                  {/* Label row */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Key size={12} style={{ color: C.accent }} />
                        <span className="text-sm font-bold text-slate-800">{label}</span>
                        {isOverridden && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{ background: C.accentBg, color: C.accent }}>
                            上書き中
                          </span>
                        )}
                        {savedVal && !isOverridden && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">
                            .env から読込済
                          </span>
                        )}
                      </div>
                      <p className="text-xs mt-0.5" style={{ color: C.muted }}>{description}</p>
                    </div>
                    {testFn && (
                      <button
                        onClick={() => handleTest(key, testFn)}
                        disabled={isTesting || !hasValue}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all flex items-center gap-1.5"
                        style={{
                          borderColor: isTesting || !hasValue ? C.border : C.accentBorder,
                          background: isTesting || !hasValue ? 'transparent' : C.accentBg,
                          color: isTesting || !hasValue ? C.muted : C.accent,
                          cursor: isTesting || !hasValue ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isTesting
                          ? <><RefreshCw size={11} className="animate-spin" /> テスト中...</>
                          : 'テスト接続'
                        }
                      </button>
                    )}
                  </div>

                  {/* Input */}
                  <input
                    type={sensitive ? 'password' : 'text'}
                    value={draftVal}
                    onChange={e => setSettingsDraft(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={
                      savedVal
                        ? (sensitive ? '••••••••（設定済み — 変更する場合のみ入力）' : savedVal)
                        : placeholder
                    }
                    className="w-full px-3 py-2.5 rounded-xl border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-300 bg-white transition-colors"
                    style={{ borderColor: draftVal ? C.accent : C.border }}
                    autoComplete="off"
                    spellCheck={false}
                  />

                  {/* Test result */}
                  {testStatus && (
                    <div
                      className="flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg"
                      style={{
                        background: testStatus.ok ? '#f0fdf4' : '#fef2f2',
                        color: testStatus.ok ? '#16a34a' : '#dc2626',
                      }}
                    >
                      {testStatus.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                      {testStatus.msg}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Danger zone */}
          <div className="mt-8 p-5 rounded-2xl border border-dashed" style={{ borderColor: '#fca5a5' }}>
            <p className="text-xs font-bold text-red-500 mb-1">設定のリセット</p>
            <p className="text-xs mb-3" style={{ color: C.muted }}>
              localStorage の上書き値をすべて削除し、.env の値に戻します。
            </p>
            <button
              onClick={() => {
                localStorage.removeItem('bp_meishi_settings');
                setSettingsDraft({});
                setSettingsTestStatus({});
                flash('.env の値にリセットしました', 'ok');
              }}
              className="text-xs font-semibold text-red-400 hover:text-red-600 transition-colors border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50"
            >
              すべてリセット
            </button>
          </div>
        </div>
      </div>
    );
  };

  /* ═══════════════════════════════════════════
     Main Render
     ═══════════════════════════════════════════ */

  // ── Global drag & drop ──
  const [globalDrag, setGlobalDrag] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current++;
      if (e.dataTransfer?.types.includes('Files')) setGlobalDrag(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) { setGlobalDrag(false); dragCounterRef.current = 0; }
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setGlobalDrag(false);
      dragCounterRef.current = 0;
      const files = Array.from(e.dataTransfer?.files || []).filter(f => f.name.toLowerCase().endsWith('.pdf'));
      if (files.length === 1) {
        handleUpload(files[0]);
      } else if (files.length >= 2) {
        handleMultiUpload(files);
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // ── Multiple PDF upload (front + back) ──
  const handleMultiUpload = async (files: File[]) => {
    setLoading(true);
    flash(`${files.length}枚のPDFを分析中...`, 'info');
    try {
      const allPagesCollected: PageData[] = [];
      for (let i = 0; i < files.length; i++) {
        const data = await analyzePdf(files[i]);
        const pages = data.pages.map((p: PageData, pi: number) => ({
          ...p,
          page_label: files.length === 2
            ? (i === 0 ? `表${pi > 0 ? ` (${pi + 1})` : ''}` : `裏${pi > 0 ? ` (${pi + 1})` : ''}`)
            : `${files[i].name.replace('.pdf', '')}${pi > 0 ? ` (${pi + 1})` : ''}`,
        }));
        allPagesCollected.push(...pages);
        if (i === 0) setPdfB64(data.pdf_b64);
      }
      setAllPages(allPagesCollected);
      setEditingProjectId(null);
      await loadPage(allPagesCollected, 0);
      setView(AppState.EDIT);
      flash(`${allPagesCollected.length}ページ検出 (${allPagesCollected.map(p => p.page_label || `P${allPagesCollected.indexOf(p)+1}`).join('・')})`, 'ok');
    } catch (e: any) {
      flash(`分析エラー: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Transcribe views ──
  const [transcribeProjects, setTranscribeProjects] = useState<TranscribeProject[]>([]);
  const [transcribeLoading, setTranscribeLoading] = useState(false);

  const handleTranscribeUpload = async (file: File) => {
    setTranscribeLoading(true);
    flash('文字起こし中…', 'info');
    try {
      const b64 = await new Promise<string>((res) => {
        const reader = new FileReader();
        reader.onload = () => res((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      const geminiKey = import.meta.env.VITE_GOOGLE_AI_KEY as string;
      if (!geminiKey) throw new Error('VITE_GOOGLE_AI_KEY が未設定です');

      const isAudio = file.type.startsWith('audio/');
      const mimeType = file.type || (isAudio ? 'audio/mp3' : 'image/png');

      const callGemini = async (model: string, prompt: string): Promise<string> => {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inline_data: { mime_type: mimeType, data: b64 } },
                  { text: prompt },
                ],
              }],
            }),
          },
        );
        if (!res.ok) throw new Error(`Gemini ${model}: ${res.status}`);
        const j = await res.json();
        return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      };

      const prompt = isAudio
        ? 'この音声に含まれるすべての発言を正確に文字起こししてください。話者が複数いる場合は話者を区別してください。タイムスタンプがわかる場合は付与してください。'
        : 'この画像/PDFに含まれるすべてのテキストを正確に文字起こししてください。改行やレイアウトを可能な限り保持してください。';

      // 合議: 複数モデルで同時実行
      const [result1, result2] = await Promise.all([
        callGemini('gemini-2.5-flash', prompt),
        callGemini('gemini-2.0-flash', prompt),
      ]);

      // 合議結果をマージ（長い方を基準に）
      const consensus = result1.length >= result2.length ? result1 : result2;

      const project: TranscribeProject = {
        id: crypto.randomUUID(),
        name: file.name,
        source_type: 'upload',
        text: consensus,
        ai_results: [
          { model: 'gemini-2.5-flash', text: result1 },
          { model: 'gemini-2.0-flash', text: result2 },
        ],
        consensus_text: consensus,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      setTranscribeProjects(prev => [project, ...prev]);
      flash('文字起こし完了（合議出力）', 'ok');
    } catch (e: any) {
      flash(`文字起こしエラー: ${e.message}`, 'error');
    } finally {
      setTranscribeLoading(false);
    }
  };

  const handleTranscribeFromDrive = async () => {
    try {
      const file = await pickFileFromDrive();
      if (file) handleTranscribeUpload(file);
    } catch (e: any) {
      flash(e.message || 'Google Drive接続エラー', 'error');
    }
  };

  const renderTranscribeList = () => (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <label className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 cursor-pointer text-white" style={{ background: C.accent }}>
          <Upload size={16} /> ファイルアップロード
          <input type="file" accept="image/*,application/pdf,audio/*" className="hidden" onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleTranscribeUpload(f);
            e.target.value = '';
          }} />
        </label>
        {isDriveConfigured() && (
          <button
            onClick={handleTranscribeFromDrive}
            className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 border"
            style={{ borderColor: C.accentBorder, color: C.accent, background: C.accentBg }}
          >
            <HardDrive size={16} /> Google Drive
          </button>
        )}
      </div>
      {transcribeLoading && (
        <div className="flex items-center gap-3 mb-4 p-4 rounded-lg" style={{ background: C.accentBg }}>
          <div className="w-5 h-5 border-2 border-teal-300 border-t-teal-600 rounded-full animate-spin" />
          <span className="text-sm font-medium" style={{ color: C.accent }}>合議処理中（複数AIモデルで同時解析）…</span>
        </div>
      )}
      {transcribeProjects.length === 0 && !transcribeLoading ? (
        <div className="text-center py-20" style={{ color: C.muted }}>
          <FileAudio size={48} className="mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium mb-2">文字起こしプロジェクトがありません</p>
          <p className="text-sm">音声・画像・PDFをアップロード、またはGoogle Driveから選択してください</p>
        </div>
      ) : (
        <div className="space-y-3">
          {transcribeProjects.map(p => (
            <div key={p.id} className="p-4 rounded-xl border" style={{ background: C.card, borderColor: C.border }}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium text-sm" style={{ color: C.text }}>{p.name}</h3>
                <div className="flex items-center gap-2">
                  {p.ai_results.map(r => (
                    <span key={r.model} className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: C.surface, color: C.muted }}>
                      {r.model}
                    </span>
                  ))}
                </div>
              </div>
              <pre className="text-xs whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto p-3 rounded-lg" style={{ background: C.surface, color: C.textSec }}>
                {p.consensus_text || p.text}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderTranscribeHistory = () => (
    <div className="flex-1 overflow-y-auto p-6">
      {transcribeProjects.length === 0 ? (
        <div className="text-center py-20" style={{ color: C.muted }}>
          <Clock size={48} className="mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">履歴はまだありません</p>
        </div>
      ) : (
        <div className="space-y-2">
          {transcribeProjects.map(p => (
            <div key={p.id} className="flex items-center gap-4 p-3 rounded-lg border" style={{ background: C.card, borderColor: C.border }}>
              <FileAudio size={18} style={{ color: C.accent }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: C.text }}>{p.name}</p>
                <p className="text-xs" style={{ color: C.muted }}>{new Date(p.created_at).toLocaleString('ja-JP')}</p>
              </div>
              <div className="flex gap-1">
                {p.ai_results.map(r => (
                  <span key={r.model} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: C.surface, color: C.muted }}>{r.model}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderTranscribeAI = () => (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: C.accentBg }}>
            <Sparkles size={32} style={{ color: C.accent }} />
          </div>
          <h3 className="text-lg font-bold mb-2" style={{ color: C.text }}>AI合議文字起こし</h3>
          <p className="text-sm" style={{ color: C.muted }}>
            複数のAIモデル（Gemini 2.5 Flash / Gemini 2.0 Flash）が同時に解析し、<br />
            最も精度の高い結果を合議で出力します
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <label className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-dashed cursor-pointer hover:border-teal-300 transition-colors"
            style={{ borderColor: C.border, background: C.surface }}>
            <Upload size={32} style={{ color: C.accent }} />
            <span className="text-sm font-medium" style={{ color: C.text }}>ファイルをアップロード</span>
            <span className="text-xs" style={{ color: C.muted }}>音声・画像・PDF対応</span>
            <input type="file" accept="image/*,application/pdf,audio/*" className="hidden" onChange={e => {
              const f = e.target.files?.[0];
              if (f) handleTranscribeUpload(f);
              e.target.value = '';
            }} />
          </label>
          {isDriveConfigured() && (
            <button
              onClick={handleTranscribeFromDrive}
              className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-dashed hover:border-teal-300 transition-colors"
              style={{ borderColor: C.border, background: C.surface }}
            >
              <HardDrive size={32} style={{ color: C.accent }} />
              <span className="text-sm font-medium" style={{ color: C.text }}>Google Driveから選択</span>
              <span className="text-xs" style={{ color: C.muted }}>Drive内の音声・画像・PDF</span>
            </button>
          )}
        </div>
        {transcribeLoading && (
          <div className="flex items-center justify-center gap-3 p-6 rounded-xl" style={{ background: C.accentBg }}>
            <div className="w-6 h-6 border-2 border-teal-300 border-t-teal-600 rounded-full animate-spin" />
            <span className="font-medium" style={{ color: C.accent }}>複数AIで合議解析中…</span>
          </div>
        )}
        <div className="mt-6 p-4 rounded-xl border" style={{ background: C.card, borderColor: C.border }}>
          <h4 className="text-xs font-bold mb-3 uppercase tracking-wider" style={{ color: C.muted }}>使用モデル</h4>
          <div className="space-y-2">
            {['Gemini 2.5 Flash', 'Gemini 2.0 Flash'].map(m => (
              <div key={m} className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ background: C.accent }} />
                <span className="text-sm" style={{ color: C.textSec }}>{m}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex text-slate-900 font-sans overflow-hidden" style={{ background: C.bg }}>
      {renderToast()}
      {renderSidebar()}
      <div className="flex-1 flex flex-col min-w-0">
        {renderHeader()}
        {view === AppState.DASHBOARD && renderDashboard()}
        {view === AppState.INBOX && renderInbox()}
        {view === AppState.AI_CHAT && renderAIChat()}
        {view === AppState.SETTINGS && renderSettings()}
        {view === AppState.TRANSCRIBE_LIST && renderTranscribeList()}
        {view === AppState.TRANSCRIBE_HISTORY && renderTranscribeHistory()}
        {view === AppState.TRANSCRIBE_AI && renderTranscribeAI()}
        {view === AppState.EDIT && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 flex flex-col min-w-0">
              {renderEditor()}
            </div>
            {showChatInEditor && renderChatPanel()}
          </div>
        )}
      </div>

      {/* Global drag & drop overlay */}
      {globalDrag && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 bg-teal-600/20 backdrop-blur-sm border-4 border-dashed border-teal-400 rounded-none" />
          <div className="relative bg-white rounded-2xl p-10 shadow-2xl text-center">
            <Upload size={48} style={{ color: C.accent }} className="mx-auto mb-4" />
            <p className="text-xl font-bold text-slate-800">PDFをドロップ</p>
            <p className="text-sm mt-2" style={{ color: C.muted }}>1枚 = 表裏一体 / 2枚 = 表と裏を統合</p>
          </div>
        </div>
      )}

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
