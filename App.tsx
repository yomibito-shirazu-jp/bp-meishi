import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Span, PageData, CardProject, AppState, TranscribeProject, AiResult } from './types';
import { analyzePdf, rebuildPdf, SpanOverride } from './services/api';
import { listProjects, saveProject, deleteProject } from './services/supabase';
import { correctOcrWithAI } from './services/ai';
import { runAgentInstruction, AgentMessage } from './services/agent';
import { pickPdfFromDrive, pickFileFromDrive } from './services/gdrive';
import { getConfig, saveConfig, getAllOverrides, ConfigKey } from './services/config';
import {
  Upload, ArrowLeft, Plus, Trash2, Save, FileText, Eye, EyeOff,
  Download, LayoutDashboard, CreditCard, ChevronLeft,
  Search, Building2, Inbox, ZoomIn, ZoomOut, Maximize, Move,
  MessageSquare, Send, Bot, Sparkles, Wand2, HardDrive,
  Settings, CheckCircle2, XCircle, Key, RefreshCw,
  FileAudio, Clock, List, LayoutTemplate, BookOpen,
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';

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

  // ── Adobe MCP ──
  const [adbConnected, setAdbConnected] = useState(false);
  const [adbSocket, setAdbSocket] = useState<Socket | null>(null);

  const connectToAdb = () => {
    if (adbSocket) return;
    const socket = io('ws://localhost:3001', { transports: ['websocket'] });
    socket.on('connect', () => {
      setAdbConnected(true);
      flash('Adobe Local Proxyへ接続しました', 'ok');
    });
    socket.on('disconnect', () => {
      setAdbConnected(false);
      flash('Adobe Local Proxyから切断されました', 'error');
    });
    setAdbSocket(socket);
  };

  const sendToIllustrator = () => {
    if (!adbSocket || !adbConnected) {
      flash('Adobe Proxyに接続されていません', 'error');
      return;
    }
    
    // Create script dynamically based on spans, or sample if none
    const textObjects = spans.length > 0 ? spans.map(s => {
      const pageW = pageMM[0] / 25.4 * 72; // Convert mm to pt
      const pageH = pageMM[1] / 25.4 * 72;
      const x = (s.x_pct / 100) * pageW;
      const y = -((s.y_pct / 100) * pageH); // standard AI coordinates
      return `
        var t = doc.textFrames.add();
        t.contents = ${JSON.stringify(s.text)};
        t.position = [${x}, ${y}];
        t.textRange.characterAttributes.size = ${s.size_pt || 10};
      `;
    }).join('\\n') : `
      var t = doc.textFrames.add();
      t.contents = 'テキストフィールドがありません';
      t.position = [50, -50];
      t.textRange.characterAttributes.size = 20;
    `;

    const docWidth = (pageMM[0] / 25.4) * 72;
    const docHeight = (pageMM[1] / 25.4) * 72;

    const scriptString = `
      var doc = app.documents.add(DocumentColorSpace.CMYK, ${docWidth}, ${docHeight});
      ${textObjects}
    `;

    adbSocket.emit('command_packet', {
      application: 'illustrator',
      command: {
        action: 'executeExtendScript',
        options: { scriptString }
      }
    });

    flash('Illustratorへ組版コマンドを送信しました', 'ok');
  };

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
      {
        title: 'Adobe自動組版',
        items: [
          { icon: LayoutTemplate, label: '一覧', badge: 0, state: AppState.TYPESET_LIST },
          { icon: BookOpen, label: '履歴', badge: 0, state: AppState.TYPESET_HISTORY },
          { icon: Sparkles, label: 'AI組版', badge: 0, state: AppState.TYPESET_AI },
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
        {view === AppState.TYPESET_LIST && <h2 className="text-base font-bold text-slate-800">自動組版一覧</h2>}
        {view === AppState.TYPESET_HISTORY && <h2 className="text-base font-bold text-slate-800">組版履歴</h2>}
        {view === AppState.TYPESET_AI && (
          <div className="flex items-center gap-2">
            <LayoutTemplate size={16} style={{ color: C.accent }} />
            <h2 className="text-base font-bold text-slate-800">AI自動組版</h2>
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
              onClick={async () => {
                try {
                  const file = await pickPdfFromDrive();
                  if (file) handleUpload(file);
                } catch (e: any) {
                  flash(e.message || 'Google Drive接続エラー', 'error');
                }
              }}
              className="text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90"
              style={{ background: C.accent }}
            >
              <HardDrive size={16} /> Google Drive
            </button>
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
                className="mt-4 text-white px-5 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 mx-auto transition-colors hover:opacity-90 shadow-sm"
                style={{ background: C.accent }}
              >
                <HardDrive size={16} /> Google Driveから選択
              </button>
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
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-preview-05-20:generateContent?key=${apiKey}`,
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

    // Google OAuth fields (separate section)
    const oauthFields: FieldDef[] = [
      {
        key: 'VITE_GOOGLE_CLIENT_ID',
        label: 'Google OAuth Client ID',
        description: 'GCP コンソール → 認証情報 → OAuth 2.0 クライアント ID',
        placeholder: 'xxxxx.apps.googleusercontent.com',
        sensitive: false,
      },
      {
        key: 'GOOGLE_CLIENT_SECRET',
        label: 'Google OAuth Client Secret',
        description: 'OAuth 2.0 クライアント シークレット',
        placeholder: 'GOCSPX-...',
        sensitive: true,
      },
      {
        key: 'VITE_GOOGLE_API_KEY',
        label: 'Google API Key (Picker)',
        description: 'Picker API / Drive API 用の API キー',
        placeholder: 'AIzaSy...',
        sensitive: false,
      },
    ];

    const currentOrigin = window.location.origin;

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
        if (v !== undefined) saveConfig(k as ConfigKey, v as string);
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
                        {hasValue ? (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">有効</span>
                        ) : (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">未設定</span>
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

          {/* Google Drive / OAuth section */}
          <div className="mt-8">
            <h3 className="text-sm font-bold text-slate-800 mb-1">Google Drive 連携</h3>
            <p className="text-xs mb-4" style={{ color: C.muted }}>
              Google Drive Picker を使うための OAuth 設定です。
            </p>

            {/* Redirect URI info box */}
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
              <p className="text-xs font-bold text-amber-700 mb-2">
                GCP OAuth 設定に以下を登録してください
              </p>
              <div className="space-y-2">
                <div>
                  <p className="text-[10px] font-semibold text-amber-600 mb-0.5">承認済みの JavaScript 生成元</p>
                  <code className="block text-xs font-mono bg-white border border-amber-200 rounded-lg px-3 py-1.5 select-all text-slate-700">
                    {currentOrigin}
                  </code>
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-amber-600 mb-0.5">承認済みのリダイレクト URI</p>
                  <code className="block text-xs font-mono bg-white border border-amber-200 rounded-lg px-3 py-1.5 select-all text-slate-700">
                    {currentOrigin}
                  </code>
                </div>
              </div>
            </div>

            {/* Status indicator */}
            {(() => {
              const clientId = getConfig('VITE_GOOGLE_CLIENT_ID');
              const apiKey = getConfig('VITE_GOOGLE_API_KEY');
              const allSet = !!(clientId && apiKey);
              return (
                <div className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg mb-4 ${allSet ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                  {allSet ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  {allSet
                    ? 'Google Drive 連携: 有効（Client ID・API Key 設定済み）'
                    : `Google Drive 連携: 無効（${!clientId ? 'Client ID' : ''}${!clientId && !apiKey ? ' / ' : ''}${!apiKey ? 'API Key' : ''} 未設定）`
                  }
                </div>
              );
            })()}

            <div className="space-y-4">
              {oauthFields.map(({ key, label, description, placeholder, sensitive }) => {
                const draftVal = settingsDraft[key] ?? '';
                const savedVal = getConfig(key);
                const isOverridden = getAllOverrides()[key] !== undefined;

                return (
                  <div
                    key={key}
                    className="bg-white rounded-2xl border p-5 space-y-3 transition-shadow hover:shadow-sm"
                    style={{ borderColor: draftVal ? C.accentBorder : C.border }}
                  >
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
                      {savedVal ? (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">有効</span>
                      ) : (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">未設定</span>
                      )}
                    </div>
                    <p className="text-xs" style={{ color: C.muted }}>{description}</p>
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
                  </div>
                );
              })}
            </div>
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

      const geminiKey = getConfig('VITE_GOOGLE_AI_KEY');
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
        callGemini('gemini-3-flash', prompt),
        callGemini('gemini-3.1-pro', prompt),
      ]);

      // 合議結果をマージ（長い方を基準に）
      const consensus = result1.length >= result2.length ? result1 : result2;

      const project: TranscribeProject = {
        id: crypto.randomUUID(),
        name: file.name,
        source_type: 'upload',
        text: consensus,
        ai_results: [
          { model: 'gemini-3-flash', text: result1 },
          { model: 'gemini-3.1-pro', text: result2 },
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
        <button
          onClick={handleTranscribeFromDrive}
          className="text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90"
          style={{ background: C.accent }}
        >
          <HardDrive size={16} /> Google Driveから選択
        </button>
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
          <p className="text-sm">Google Driveから音声・画像・PDFを選択してください</p>
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
        <div className="flex justify-center mb-6">
          <button
            onClick={handleTranscribeFromDrive}
            className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-dashed hover:border-teal-300 transition-colors w-full max-w-md"
            style={{ borderColor: C.border, background: C.surface }}
          >
            <HardDrive size={32} style={{ color: C.accent }} />
            <span className="text-sm font-medium" style={{ color: C.text }}>Google Driveから選択</span>
            <span className="text-xs" style={{ color: C.muted }}>音声・画像・PDF対応</span>
          </button>
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

  // ── Typeset (自動組版) views ──
  const [typesetProjects, setTypesetProjects] = useState<{
    id: string; name: string; source: string; pages: number;
    template: string; status: 'done' | 'processing' | 'error';
    pdf_b64?: string; preview_png?: string;
    created_at: string;
  }[]>([]);
  const [typesetLoading, setTypesetLoading] = useState(false);

  const handleTypesetFromDrive = async () => {
    try {
      const file = await pickFileFromDrive();
      if (!file) return;
      setTypesetLoading(true);
      flash('自動組版中…', 'info');

      // PDFをBase64に変換
      const b64 = await new Promise<string>((res) => {
        const reader = new FileReader();
        reader.onload = () => res((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      const geminiKey = getConfig('VITE_GOOGLE_AI_KEY');
      if (!geminiKey) throw new Error('VITE_GOOGLE_AI_KEY が未設定です');

      // Geminiで文書構造を解析 → 組版指示を生成
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: file.type || 'application/pdf', data: b64 } },
                { text: `この文書を解析して、以下のJSON形式で自動組版データを返してください:
{
  "title": "文書タイトル",
  "page_count": ページ数,
  "sections": [
    { "type": "heading"|"body"|"caption"|"footer", "text": "テキスト内容", "font_size_pt": 数値, "font_weight": "normal"|"bold", "alignment": "left"|"center"|"right" }
  ],
  "suggested_template": "business_card"|"flyer"|"report"|"brochure"|"poster"
}
JSONのみ返してください。` },
              ],
            }],
          }),
        },
      );
      if (!res.ok) throw new Error(`Gemini: ${res.status}`);
      const j = await res.json();
      const raw = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      // Extract JSON from response
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { title: file.name, page_count: 1, sections: [], suggested_template: 'report' };

      const project = {
        id: crypto.randomUUID(),
        name: parsed.title || file.name,
        source: file.name,
        pages: parsed.page_count || 1,
        template: parsed.suggested_template || 'report',
        status: 'done' as const,
        created_at: new Date().toISOString(),
      };

      setTypesetProjects(prev => [project, ...prev]);
      flash(`組版完了: ${parsed.sections?.length || 0}セクション検出`, 'ok');
    } catch (e: any) {
      flash(`組版エラー: ${e.message}`, 'error');
    } finally {
      setTypesetLoading(false);
    }
  };

  const TEMPLATE_LABELS: Record<string, string> = {
    business_card: '名刺', flyer: 'チラシ', report: 'レポート',
    brochure: 'パンフ', poster: 'ポスター',
  };

  const renderTypesetList = () => (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={handleTypesetFromDrive}
          className="text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90"
          style={{ background: C.accent }}
        >
          <HardDrive size={16} /> Google Driveから選択
        </button>
      </div>
      {typesetLoading && (
        <div className="flex items-center gap-3 mb-4 p-4 rounded-lg" style={{ background: C.accentBg }}>
          <div className="w-5 h-5 border-2 border-teal-300 border-t-teal-600 rounded-full animate-spin" />
          <span className="text-sm font-medium" style={{ color: C.accent }}>AI組版解析中…</span>
        </div>
      )}
      {typesetProjects.length === 0 && !typesetLoading ? (
        <div className="text-center py-20" style={{ color: C.muted }}>
          <LayoutTemplate size={48} className="mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium mb-2">組版プロジェクトがありません</p>
          <p className="text-sm">Google Driveから文書を選択してAI自動組版</p>
        </div>
      ) : (
        <div className="space-y-3">
          {typesetProjects.map(p => (
            <div key={p.id} className="p-4 rounded-xl border" style={{ background: C.card, borderColor: C.border }}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium text-sm" style={{ color: C.text }}>{p.name}</h3>
                  <p className="text-xs mt-1" style={{ color: C.muted }}>{p.source} · {p.pages}ページ</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: C.accentBg, color: C.accent }}>
                    {TEMPLATE_LABELS[p.template] || p.template}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full" style={{
                    background: p.status === 'done' ? '#dcfce7' : p.status === 'processing' ? '#fef9c3' : '#fee2e2',
                    color: p.status === 'done' ? '#166534' : p.status === 'processing' ? '#854d0e' : '#991b1b',
                  }}>
                    {p.status === 'done' ? '完了' : p.status === 'processing' ? '処理中' : 'エラー'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderTypesetHistory = () => (
    <div className="flex-1 overflow-y-auto p-6">
      {typesetProjects.length === 0 ? (
        <div className="text-center py-20" style={{ color: C.muted }}>
          <BookOpen size={48} className="mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">履歴はまだありません</p>
        </div>
      ) : (
        <div className="space-y-2">
          {typesetProjects.map(p => (
            <div key={p.id} className="flex items-center gap-4 p-3 rounded-lg border" style={{ background: C.card, borderColor: C.border }}>
              <LayoutTemplate size={18} style={{ color: C.accent }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: C.text }}>{p.name}</p>
                <p className="text-xs" style={{ color: C.muted }}>{new Date(p.created_at).toLocaleString('ja-JP')}</p>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: C.surface, color: C.muted }}>
                {TEMPLATE_LABELS[p.template] || p.template}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const [showAiTutorial, setShowAiTutorial] = useState(false);

  const renderTypesetAI = () => (
    <div className="flex-1 overflow-y-auto p-6" style={{ background: C.bg }}>
      <div className="max-w-2xl mx-auto pb-20 relative">
        <div className="text-center mb-8">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-sm" style={{ background: 'linear-gradient(135deg, #1e293b, #0f172a)' }}>
            <img src="https://upload.wikimedia.org/wikipedia/commons/f/fb/Adobe_Illustrator_CC_icon.svg" width="40" height="40" alt="Illustrator" />
          </div>
          <h3 className="text-2xl font-bold mb-3" style={{ color: C.text }}>Adobe Illustrator 連携自動組版</h3>
          <p className="text-base font-medium flex flex-col gap-3 text-rose-600 bg-rose-50 p-4 rounded-xl border border-rose-200">
            <span>
              名刺データをIllustratorの完全な印刷用データに変換します。<br/>
              必ず以下の【ステップ１〜３】を順番に確認・実行してください。
            </span>
            <button 
              onClick={() => setShowAiTutorial(true)}
              className="mx-auto flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow border border-rose-200 text-rose-700 hover:bg-rose-100 transition-colors"
            >
              <BookOpen size={18} /> 最初にお読みください（チュートリアルと初期設定）
            </button>
          </p>
        </div>

        {showAiTutorial && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
              <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
                <h3 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                  <Wand2 className="text-sky-500" /> Illustrator自動組版 チュートリアル
                </h3>
                <button onClick={() => setShowAiTutorial(false)} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
                  <XCircle size={24} />
                </button>
              </div>
              
              <div className="p-8 space-y-8">
                <div className="bg-slate-50 rounded-xl p-6 border border-slate-200">
                  <h4 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                    <span className="bg-slate-800 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold">1</span>
                    事前のインストール設定（初回のみ）
                  </h4>
                  <div className="space-y-4 text-sm text-slate-600">
                    <p>この機能を使うには、お使いのPCのIllustratorに専用プラグインを入れる必要があります。</p>
                    <ol className="list-decimal pl-5 space-y-2">
                      <li><code>mcp/adb-mcp-main/adb-mcp-main/cep/com.mikechambers.ai</code> フォルダをコピーします。</li>
                      <li><code>C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\</code> <br/>または <code>C:\Users\あなたの名前\AppData\Roaming\Adobe\CEP\extensions\</code> の中に貼り付けます。</li>
                      <li>Illustratorを再起動します。</li>
                    </ol>
                  </div>
                </div>

                <div className="bg-slate-50 rounded-xl p-6 border border-slate-200">
                  <h4 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                    <span className="bg-slate-800 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold">2</span>
                    プロキシサーバーの起動（毎回）
                  </h4>
                  <div className="space-y-4 text-sm text-slate-600">
                    <p>Illustratorとこのアプリを通信させるための「中継ソフト（プロキシ）」を起動します。</p>
                    <ol className="list-decimal pl-5 space-y-2">
                      <li>コマンドプロンプトやターミナルを開きます。</li>
                      <li><code>cd mcp/adb-mcp-main/adb-mcp-main/adb-proxy-socket</code> に移動します。</li>
                      <li><code>npm install</code>（初回のみ）を実行後、<code>node proxy.js</code> を実行します。</li>
                      <li>黒い画面に「Server running on port 3001」と出れば成功です。そのまま画面を閉じずに置いておきます。</li>
                    </ol>
                  </div>
                </div>

                <div className="bg-slate-50 rounded-xl p-6 border border-slate-200">
                  <h4 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                    <span className="bg-slate-800 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold">3</span>
                    自動組版の実行手順
                  </h4>
                  <div className="space-y-4 text-sm text-slate-600">
                    <ol className="list-decimal pl-5 space-y-3">
                      <li>
                        <strong>データの準備:</strong> 左側メニュー「一覧」から、組版したい名刺データを選んで開きます。<br/>
                        <span className="text-emerald-600 font-medium">※現在の画面の「ステップ1」が準備完了（緑色）になっていればOKです。</span>
                      </li>
                      <li>
                        <strong>Illustrator側の準備:</strong> Illustratorのメニューバーから <code>ウィンドウ {'>'} エクステンション {'>'} Illustrator MCP Agent</code> を開きます。
                      </li>
                      <li>
                        <strong>接続の開始:</strong> エクステンション画面の「Connect」を押し、続いてこの画面の「ステップ2」の「Illustratorと通信を開始する」を押します。<br/>
                        <span className="text-emerald-600 font-medium">※両方とも（緑色）になれば準備完了です！</span>
                      </li>
                      <li>
                        <strong>実行:</strong> 最後に「 Illustlatorで自動組版を開始する」を押すと、Illustratorの画面で自動的にテキストが配置されます。
                      </li>
                    </ol>
                  </div>
                </div>
              </div>
              <div className="sticky bottom-0 bg-white border-t px-6 py-4 text-center rounded-b-2xl">
                <button 
                  onClick={() => setShowAiTutorial(false)}
                  className="bg-slate-800 text-white px-8 py-3 rounded-xl font-bold hover:bg-slate-700 transition-colors shadow-lg"
                >
                  確認した（チュートリアルを閉じる）
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-6">
          {/* STEP 1: Select Card */}
          <div className="bg-white rounded-2xl shadow-sm border p-6 flex items-start gap-4 transition-all" style={{ borderColor: spans.length > 0 ? '#10b981' : '#f43f5e', borderWidth: spans.length > 0 ? '1px' : '2px' }}>
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-white shrink-0 shadow-md ${spans.length > 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}>
              1
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-lg mb-2" style={{ color: C.text }}>印刷対象データの設定</h4>
              {spans.length > 0 ? (
                <div className="bg-emerald-50 text-emerald-700 p-3 rounded-lg border border-emerald-100 flex items-center gap-2 font-medium">
                  <CheckCircle2 size={18} className="shrink-0" />
                  準備完了： 現在 {spans.length} 個の要素が選択されています
                </div>
              ) : (
                <div className="bg-rose-50 text-rose-700 p-4 rounded-lg border border-rose-100 flex flex-col gap-2">
                  <p className="font-bold flex items-center gap-2 text-base">
                    <XCircle size={18} className="shrink-0" /> エラー: 印刷データがありません
                  </p>
                  <p className="text-sm pl-6">
                    左側メニューの「一覧」から印刷したい名刺を選択し、<br/>データが表示された状態にしてからここに戻ってきてください。
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* STEP 2: Connection */}
          <div className="bg-white rounded-2xl shadow-sm border p-6 flex items-start gap-4 transition-all" style={{ borderColor: adbConnected ? '#10b981' : '#f59e0b', borderWidth: adbConnected ? '1px' : '2px' }}>
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-white shrink-0 shadow-md ${adbConnected ? 'bg-emerald-500' : 'bg-amber-500'}`}>
              2
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-lg mb-2" style={{ color: C.text }}>Illustrator 通信チェック</h4>
              {adbConnected ? (
                <div className="bg-emerald-50 text-emerald-700 p-3 rounded-lg border border-emerald-100 flex items-center gap-2 font-medium">
                  <CheckCircle2 size={18} className="shrink-0" />
                  準備完了： Illustratorに正しく接続されています
                </div>
              ) : (
                <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
                  <p className="text-amber-800 font-bold mb-3 flex items-center gap-2">
                    <XCircle size={18} className="shrink-0" /> 未接続： 通信を開始してください
                  </p>
                  <ol className="list-decimal pl-6 text-sm text-amber-900 space-y-2 mb-5 font-medium">
                    <li>PC上で <strong>adb-proxy-socket</strong> を起動したままにする</li>
                    <li><strong>Illustrator</strong>を開き、エクステンションから「Illustrator MCP Agent」を開いて「Connect」ボタンを押す</li>
                    <li>下のボタンを押してアプリと通信をつなぐ</li>
                  </ol>
                  <button 
                    onClick={connectToAdb}
                    className="w-full py-3.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold transition flex items-center justify-center gap-2 shadow-md"
                  >
                    <RefreshCw size={18} /> Illustratorと通信を開始する
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* STEP 3: Execution */}
          <div className="bg-white rounded-2xl shadow-sm p-8 flex flex-col items-center gap-4 transition-all" style={{ border: (spans.length > 0 && adbConnected) ? '2px solid #0ea5e9' : '1px solid #e2e8f0', background: (spans.length > 0 && adbConnected) ? '#f0f9ff' : '#ffffff' }}>
            <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg text-white shadow-md ${spans.length > 0 && adbConnected ? 'bg-sky-500' : 'bg-slate-300'}`}>
              3
            </div>
            <h4 className="font-bold text-xl my-1 w-full text-center" style={{ color: C.text }}>最終実行</h4>
            <p className="text-sm font-medium text-slate-500 text-center mb-2">
              ステップ1とステップ2が両方とも「準備完了」の場合のみボタンが押せます。<br/>
              ボタンを押すとIllustratorが自動的に動作を開始します。
            </p>
            <button
              onClick={sendToIllustrator}
              disabled={!(spans.length > 0 && adbConnected)}
              className="w-full py-5 rounded-2xl font-bold text-xl text-white shadow-xl transition-all flex items-center justify-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: (spans.length > 0 && adbConnected) ? 'linear-gradient(135deg, #ff7a00, #ff4d00)' : '#94a3b8' }}
            >
              <img src="https://upload.wikimedia.org/wikipedia/commons/f/fb/Adobe_Illustrator_CC_icon.svg" width="24" height="24" alt="Illustrator" className={!(spans.length > 0 && adbConnected) ? "opacity-50 grayscale" : ""} />
              Illustratorで自動組版を開始する
            </button>
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
        {view === AppState.TYPESET_LIST && renderTypesetList()}
        {view === AppState.TYPESET_HISTORY && renderTypesetHistory()}
        {view === AppState.TYPESET_AI && renderTypesetAI()}
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
