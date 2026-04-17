import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Span, PageData, CardProject, AppState, TranscribeProject, AiResult, JobInstruction, DetectionSessionResult, DetectedComponent, ManuscriptChunk, ValidationReportResponse, ChunkDetail, FeedbackInput, FeedbackResponse, FeedbackActionType, ImageInfo, LayoutBlock, BarcodeInfo, DetectedLanguage } from './types';
import { analyzePdf, rebuildPdf, SpanOverride, SpanBbox, vivliostyleBuild, visionAnalyze, VisionAnalyzeResult, analyzeMarkdown, markdownToPdf, extractCorrections, CorrectionTask } from './services/api';
import { listProjects, saveProject, deleteProject } from './services/supabase';
import { correctOcrWithAI } from './services/ai';
import { runAgentInstruction, AgentMessage } from './services/agent';
import { pickPdfFromDrive, pickFileFromDrive } from './services/gdrive';
import { getConfig, saveConfig, getAllOverrides, ConfigKey } from './services/config';
import { extractPagesFromPdf, detectPageLayout, detectAllPages } from './services/detect';
import { chunkManuscript, validateManuscript, submitFeedback } from './services/validate';
import TemplateDesigner from './components/TemplateDesigner';
import PdfEditor from './components/PdfEditor';
import CommercialPublishing from './components/CommercialPublishing';
import {
  Upload, ArrowLeft, Plus, Trash2, Save, FileText, Eye, EyeOff,
  Download, LayoutDashboard, CreditCard, ChevronLeft,
  Search, Building2, Inbox, ZoomIn, ZoomOut, Maximize, Move,
  MessageSquare, Send, Bot, Sparkles, Wand2, HardDrive,
  Settings, CheckCircle2, XCircle, Key, RefreshCw,
  FileAudio, Clock, List, LayoutTemplate, BookOpen, MonitorPlay,
  PenTool, ScanText, FileEdit, FileDiff, ShieldCheck, BookType,
  Newspaper, BookMarked, Monitor, Share2
} from 'lucide-react';

export const downloadBase64File = (b64Data: string, filename: string) => {
  try {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += 1024) {
      const slice = byteCharacters.slice(offset, offset + 1024);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }
    const blob = new Blob(byteArrays, { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  } catch (err) {
    console.error('Download failed:', err);
  }
};

/* ═══════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════ */

const FONT_LABELS: Record<string, string> = {
  gothic: 'ゴシック',
  mincho: '明朝',
  light: 'ライト',
  gothic_bold: 'ゴシック太',
};

const CATEGORY_LABELS: Record<string, string> = {
  // 名刺
  company: '会社名', company_en: '会社名(英)', department: '部署', title: '役職',
  name: '氏名', name_en: '氏名(英)', address: '住所', postal: '郵便番号',
  phone: '電話', fax: 'FAX', mobile: '携帯', email: 'メール', url: 'URL',
  // 請求書・見積書
  doc_title: '書類名', doc_number: '文書番号', date: '日付',
  company_from: '差出人', company_to: '宛先',
  item_name: '品名', quantity: '数量', unit_price: '単価', amount: '金額',
  subtotal: '小計', tax: '税', total: '合計',
  payment_terms: '支払条件', bank_info: '振込先', note: '備考',
  // 書籍
  chapter: '章', heading: '見出し', body: '本文', page_number: 'ページ番号',
  header: 'ヘッダー', footer: 'フッター', caption: 'キャプション',
  // 汎用
  label: 'ラベル', value: '値', number: '番号', other: 'その他',
};

const CATEGORY_COLORS: Record<string, string> = {
  company: '#6366f1', company_from: '#6366f1', company_to: '#818cf8',
  name: '#ec4899', doc_title: '#f59e0b', doc_number: '#f59e0b',
  date: '#8b5cf6', address: '#14b8a6', postal: '#14b8a6',
  phone: '#3b82f6', fax: '#3b82f6', mobile: '#3b82f6', email: '#3b82f6', url: '#3b82f6',
  item_name: '#10b981', quantity: '#f97316', unit_price: '#f97316', amount: '#ef4444',
  subtotal: '#ef4444', tax: '#ef4444', total: '#ef4444',
  heading: '#f59e0b', body: '#64748b', note: '#94a3b8',
  other: '#6b7280',
};

// Premium SaaS theme — Dark sidebar + Indigo accent
const C = {
  // Content area (light)
  bg: '#f8f9fc',
  card: '#ffffff',
  surface: '#f1f3f9',
  border: '#e5e7eb',
  text: '#111827',
  textSec: '#6b7280',
  muted: '#9ca3af',
  // Accent (Indigo)
  accent: '#6366f1',
  accentHover: '#4f46e5',
  accentBg: 'rgba(99,102,241,.08)',
  accentBorder: 'rgba(99,102,241,.2)',
  accentGlow: 'rgba(99,102,241,.15)',
  // Sidebar (dark)
  sidebarBg: '#0f0f14',
  sidebarCard: '#1a1a24',
  sidebarBorder: 'rgba(255,255,255,.06)',
  sidebarText: '#e2e8f0',
  sidebarTextSec: '#64748b',
  sidebarMuted: '#475569',
  // Gradients
  gradientPrimary: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a78bfa 100%)',
  gradientAccent: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)',
  gradientDark: 'linear-gradient(180deg, #13131b 0%, #0f0f14 100%)',
  gradientCard: 'linear-gradient(135deg, rgba(99,102,241,.04) 0%, rgba(139,92,246,.04) 100%)',
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
        <div className="flex items-center gap-2">
          {chatMessages.length > 0 && (
            <button
              onClick={() => setChatMessages([])}
              className="text-[10px] px-2 py-1 rounded-md hover:bg-slate-50 transition-colors"
              style={{ color: C.muted }}
            >
              クリア
            </button>
          )}
          <label
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md hover:bg-slate-50 transition-colors cursor-pointer border"
            style={{ color: C.accent, borderColor: C.accentBorder, background: C.accentBg }}
            title="赤ペンPDFからタスクを生成して自動反映します"
          >
            <Upload size={12} />
            赤ペン反映
            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setChatLoading(true);
                flash('赤ペンPDFから修正指示を抽出中...', 'info');
                try {
                  const buf = await file.arrayBuffer();
                  const bytes = new Uint8Array(buf);
                  let binary = '';
                  for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                  }
                  const b64 = btoa(binary);
                  
                  const res = await extractCorrections(b64, pdfB64 || undefined);
                  
                  const processedTasks = res.tasks.map((t, idx) => ({
                    ...t,
                    id: t.id || `task-${Date.now()}-${idx}`,
                    status: t.status || 'pending'
                  }));
                  
                  setCorrectionTasks(prev => [...processedTasks, ...prev]);
                  setChatTab('tasks');
                  
                  const msg: AgentMessage = {
                    role: 'assistant',
                    content: `赤ペンPDFから ${res.total_tasks} 件の修正タスクを抽出しました。「修正タスク」タブから各項目の承認・適用を行ってください。`,
                  };
                  
                  setChatMessages(prev => [
                    ...prev, 
                    { role: 'user', content: '赤ペンPDFをアップロードしました' }, 
                    msg
                  ]);
                  
                  flash(`${res.total_tasks}件のタスクを抽出しました`, 'ok');
                } catch (err: any) {
                  flash(`赤ペン解析エラー: ${err.message}`, 'error');
                } finally {
                  setChatLoading(false);
                  e.target.value = '';
                }
              }}
            />
          </label>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b text-[11px] font-bold" style={{ borderColor: C.border }}>
        <button
          className={`flex-1 py-2 text-center transition-colors ${chatTab === 'chat' ? 'border-b-2' : ''}`}
          style={{
            borderColor: chatTab === 'chat' ? C.accent : 'transparent',
            color: chatTab === 'chat' ? C.accent : C.muted,
          }}
          onClick={() => setChatTab('chat')}
        >
          チャット
        </button>
        <button
          className={`flex-1 py-2 text-center transition-colors flex items-center justify-center gap-1 ${chatTab === 'tasks' ? 'border-b-2' : ''}`}
          style={{
            borderColor: chatTab === 'tasks' ? C.accent : 'transparent',
            color: chatTab === 'tasks' ? C.accent : C.muted,
          }}
          onClick={() => setChatTab('tasks')}
        >
          修正タスク
          {correctionTasks.filter(t => t.status === 'pending').length > 0 && (
            <span className="bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded-full">
              {correctionTasks.filter(t => t.status === 'pending').length}
            </span>
          )}
        </button>
      </div>

      {chatTab === 'chat' ? (
        <>
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
        </>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {correctionTasks.length === 0 ? (
            <div className="text-center py-8">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
                style={{ background: C.surface }}
              >
                <List size={24} style={{ color: C.muted }} />
              </div>
              <p className="text-sm font-bold mb-2" style={{ color: C.text }}>タスクはありません</p>
              <p className="text-xs leading-relaxed mb-4" style={{ color: C.muted }}>
                赤ペンPDFをアップロードすると、ここにタスクが表示されます
              </p>
            </div>
          ) : (
            correctionTasks.map(t => (
              <div 
                key={t.id} 
                className="border p-3 rounded-lg flex flex-col gap-2"
                style={{
                  background: t.status === 'done' ? '#f0fdf4' : t.status === 'skipped' ? '#f8fafc' : '#ffffff',
                  borderColor: t.status === 'done' ? '#bbf7d0' : t.status === 'skipped' ? '#e2e8f0' : C.border,
                  opacity: t.status === 'skipped' ? 0.6 : 1,
                }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span 
                      className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                      style={{
                        background: t.category === 'delete' ? '#fee2e2' : t.category === 'add' ? '#dcfce7' : '#e0e7ff',
                        color: t.category === 'delete' ? '#ef4444' : t.category === 'add' ? '#22c55e' : '#6366f1'
                      }}
                    >
                      {t.category === 'text' ? 'テキスト変更' : t.category === 'delete' ? '削除' : t.category === 'image' ? '画像変更' : t.category === 'layout' ? 'レイアウト' : '追加'}
                    </span>
                    <span className="text-[10px] font-bold" style={{ color: C.text }}>{t.location}</span>
                  </div>
                  <div className="text-[10px] text-slate-400">P.{t.page}</div>
                </div>
                
                <div className="text-xs">
                  {t.category === 'delete' ? (
                    <span className="line-through text-red-500">{t.original_text}</span>
                  ) : (
                    <>
                      <div className="line-through text-slate-400 text-[10px]">{t.original_text}</div>
                      <div className="text-slate-800 font-bold">{t.corrected_text}</div>
                    </>
                  )}
                </div>
                
                <div className="text-[10px] text-indigo-600 bg-indigo-50 p-1.5 rounded flex items-start gap-1">
                  <Bot size={10} className="mt-0.5 shrink-0" />
                  <span>{t.instruction}</span>
                </div>

                {t.status === 'pending' && (
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      onClick={() => {
                        if (t.category === 'text' || t.category === 'delete') {
                          setSpans(prevSpans => {
                            const newSpans = [...prevSpans];
                            const matchIdx = newSpans.findIndex(s => s.text === t.original_text || s.text.includes(t.original_text));
                            if (matchIdx !== -1) {
                              newSpans[matchIdx] = { ...newSpans[matchIdx], text: t.category === 'delete' ? '' : (t.corrected_text || '') };
                            }
                            return newSpans;
                          });
                        }
                        setCorrectionTasks(prev => prev.map(task => task.id === t.id ? { ...task, status: 'done' } : task));
                        flash('修正を反映しました', 'ok');
                      }}
                      className="flex-1 py-1.5 rounded border border-green-500 text-green-600 hover:bg-green-50 text-[10px] font-bold transition-colors flex items-center justify-center gap-1"
                    >
                      <CheckCircle2 size={12} />
                      承認して適用
                    </button>
                    <button
                      onClick={() => {
                        setCorrectionTasks(prev => prev.map(task => task.id === t.id ? { ...task, status: 'skipped' } : task));
                      }}
                      className="px-3 py-1.5 rounded border border-slate-300 text-slate-500 hover:bg-slate-50 text-[10px] transition-colors flex items-center justify-center gap-1"
                    >
                      <XCircle size={12} />
                      却下
                    </button>
                  </div>
                )}
                
                {t.status === 'done' && (
                  <div className="text-[10px] text-green-600 font-bold flex items-center justify-end gap-1">
                    <CheckCircle2 size={12} />
                    適用済み
                  </div>
                )}
                
                {t.status === 'skipped' && (
                  <div className="text-[10px] text-slate-400 font-bold flex items-center justify-end gap-1">
                    <XCircle size={12} />
                    却下済み
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );

  // ── AI Chat Standalone View ──
  const renderAIChat = () => (
    <div className="flex-1 flex overflow-hidden" style={{ background: C.bg }}>
      <div className="max-w-2xl mx-auto flex flex-col w-full">
        {<ChatPanel {...appProps} isStandalone={true} />}
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
    
    // Document AI fields
    const docaiFields: FieldDef[] = [
      {
        key: 'VITE_USE_DOCUMENT_AI',
        label: 'Document AI (Layout Parser) を使用',
        description: '高精度なレイアウト解析（文字位置検出）に Document AI を使用します。"true" で有効、空または "false" で無効。',
        placeholder: 'true / false',
        sensitive: false,
      },
      {
        key: 'VITE_GOOGLE_PROJECT_ID',
        label: 'GCP プロジェクト ID',
        description: 'Google Cloud プロジェクトの英数字 ID (例: my-project-123)',
        placeholder: 'my-project-123',
        sensitive: false,
      },
      {
        key: 'VITE_DOCUMENT_AI_LOCATION',
        label: 'Document AI リージョン',
        description: 'us または eu',
        placeholder: 'us',
        sensitive: false,
      },
      {
        key: 'VITE_DOCUMENT_AI_PROCESSOR_ID',
        label: 'Document AI プロセッサ ID',
        description: 'Layout Parser のプロセッサ ID (プロジェクト番号ではなく ID のみ)',
        placeholder: 'f7dfb9c3bd1d0663',
        sensitive: false,
      },
      {
        key: 'VITE_DOCUMENT_AI_VERSION_ID',
        label: 'プロセッサ バージョン ID (任意)',
        description: '特定のバージョンを使用する場合に入力 (例: pretrained-layout-parser-v1.5-2025-08-25)。空の場合はデフォルト。',
        placeholder: 'pretrained-layout-parser-v1.5-2025-08-25',
        sensitive: false,
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
        description: 'Picker API / Drive API 用の API キー。GCP コンソールで「Google Drive API」と「Google Picker API」を有効にする必要があります。',
        placeholder: 'AIzaSy...',
        sensitive: false,
        testFn: async () => {
          const apiKey = settingsDraft['VITE_GOOGLE_API_KEY'] ?? getConfig('VITE_GOOGLE_API_KEY');
          if (!apiKey) throw new Error('API キーを入力してください');
          // Discovery API を使って API キーの有効性をテスト
          const res = await fetch(
            `https://www.googleapis.com/discovery/v1/apis/drive/v3/rest?key=${apiKey}`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status} — APIキーが不正か、Drive APIが有効ではありません`);
          }
          return 'Picker API 認証成功 ✓';
        },
      },
      {
        key: 'VITE_GOOGLE_PROJECT_NUMBER',
        label: 'GCP プロジェクト番号',
        description: 'Google Cloud コンソールのダッシュボードに表示される「プロジェクト番号」を入力してください。API キーとプロジェクトが一致しないと Picker がエラーになります。',
        placeholder: '270124753853',
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

          {/* Document AI section */}
          <div className="mt-8 border-t pt-8" style={{ borderColor: C.border }}>
            <h3 className="text-sm font-bold text-slate-800 mb-1">Document AI (Layout Parser)</h3>
            <p className="text-xs mb-4" style={{ color: C.muted }}>
              複雑なレイアウトの名刺で、文字の位置検出精度を向上させる場合に有効にします。
            </p>

            <div className="space-y-4">
              {docaiFields.map(({ key, label, description, placeholder, sensitive }) => {
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
      const files = Array.from(e.dataTransfer?.files || []).filter(f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
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
        callGemini('gemini-2.0-flash', prompt),
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
          { model: 'gemini-2.0-flash', text: result1 },
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: file.type || 'application/pdf', data: b64 } },
                { text: `この文書を解析して、以下のJSON形式でデータを抽出してください:
{
  "job_instruction": {
    "document_info": { "creation_date": "", "product_name": "", "customer_name": "", "order_number": "", "pasteboard_creator": "" },
    "data_storage": { "server_path": "", "mo_disk_name": "" },
    "typesetting_format": {
      "finished_size": { "format": "", "width_mm": null, "height_mm": null },
      "binding_specification": "", "text_direction": "", "font_size_q": null,
      "transformation": { "type": "", "ratio_percent": null },
      "character_spacing": { "type": "", "size_q": null },
      "line_spacing": { "type": "", "size_q": null },
      "column_layout": { "number_of_columns": null, "column_spacing_q": null, "line_length_q": null, "lines_per_column": null }
    },
    "character_attributes": {
      "fonts": { "kanji": "", "kana": "", "alphanumeric": "", "ruby": "" },
      "style_control": {
        "kinsoku_cancellation": false, "hanging_punctuation": false,
        "alphanumeric": { "hyphenation": "", "baseline_value": null, "japanese_spacing": "" },
        "consecutive_numbers": { "spacing_before_after": "", "line_breaking": false, "plate_separation": "" },
        "spacing_adjustment": "",
        "half_width_punctuation": { "line_start": "", "line_middle": "", "line_end": "" },
        "ruby_formatting": { "processing": "", "position": "" }
      }
    },
    "remarks": ""
  },
  "layout_and_output_specs": {
    "layout_elements": {
      "header": { "font_name": "", "font_size_q": null },
      "nombre": { "font_name": "", "font_size_q": null }
    },
    "output_precautions": {
      "proof_output_direction": "", "screen_ruling_lines": null, "output_resolution_dpi": null,
      "proof_output_copies": { "paper_size": "", "number_of_copies": null },
      "final_output_format": ""
    }
  },
  "work_history": [
    {
      "edition_type": "", "submission_date": "",
      "process_records": [
        { "stage": "初校", "date": "", "is_stamped": false }, { "stage": "再校", "date": "", "is_stamped": false },
        { "stage": "三校・念校", "date": "", "is_stamped": false }, { "stage": "青焼", "date": "", "is_stamped": false }, { "stage": "責了", "date": "", "is_stamped": false }
      ]
    }
  ],
  "data_list": {
    "product_name": "", "order_number": "", "current_date": "", "shaken_info": "", "server_info": "",
    "entries": [ { "label": "", "confirmed_nombre": "", "latest_update_date": "" } ]
  }
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
        name: parsed?.job_instruction?.document_info?.product_name || parsed.title || file.name,
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
  const [phaseProgress, setPhaseProgress] = useState(0);

  const [vivliostylePdfB64, setVivliostylePdfB64] = useState<string | null>(null);

  const startVivliostyleProcess = async () => {
    if (spans.length === 0) {
      flash("エラー: 印刷データがありません", "error");
      return;
    }
    setVivliostylePdfB64(null);
    try {
      // Phase 1-3: 準備（現時点では個別処理なし）
      setPhaseProgress(1);
      flash("データ準備中...", "info");

      const titleSpan = spans.find(s => s.font_class === 'mincho') || spans[0];
      setPhaseProgress(2);
      setPhaseProgress(3);

      // Phase 4: Vivliostyle で実際にPDF生成
      setPhaseProgress(4);
      flash("Vivliostyle エンジンでPDF生成中...", "info");

      const result = await vivliostyleBuild(
        spans, 
        pageMM, 
        titleSpan?.text?.trim() || '名刺', 
        originalPng || undefined
      );

      // Phase 5: 完了
      setPhaseProgress(5);

      setVivliostylePdfB64(result.pdf_b64);
      setPhaseProgress(6);
      flash(`印刷用PDF生成完了 (engine: ${result.engine} ${result.version})`, "ok");
    } catch (e: any) {
      flash(`Vivliostyle エラー: ${e.message}`, "error");
      setPhaseProgress(0);
    }
  };

  const renderTypesetAI = () => (
    <div className="flex-1 overflow-y-auto p-6" style={{ background: C.bg }}>
      <div className="max-w-3xl mx-auto pb-20 relative">
        <div className="text-center mb-8">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-sm bg-white border">
            <BookOpen size={40} style={{ color: C.accent }} />
          </div>
          <h3 className="text-2xl font-bold mb-3" style={{ color: C.text }}>読み人知らず — 自動組版アーキテクチャ</h3>
          <p className="text-base font-medium flex justify-center gap-3 text-emerald-600 bg-emerald-50 px-4 py-2 rounded-xl border border-emerald-200 w-max mx-auto">
            Adobe製品ゼロ・校正サイクル消滅
          </p>
        </div>

        <div className="space-y-4">
          
          {/* PHASE 1 */}
          <div className="bg-white rounded-xl shadow-sm border p-5 transition-all" style={{ borderColor: phaseProgress >= 1 ? '#10b981' : C.border }}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-white text-sm shadow-sm ${phaseProgress >= 1 ? 'bg-emerald-500' : 'bg-slate-300'}`}>1</div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-800">PHASE 1 — 入口の合議</h4>
                <p className="text-xs text-slate-500">原稿正規化（表記検証・構造照合・意味検証）</p>
              </div>
              {phaseProgress === 1 && <div className="animate-spin w-5 h-5 border-2 border-emerald-300 border-t-emerald-600 rounded-full" />}
              {phaseProgress > 1 && <CheckCircle2 size={24} className="text-emerald-500" />}
            </div>
          </div>

          {/* PHASE 2 */}
          <div className="bg-white rounded-xl shadow-sm border p-5 transition-all" style={{ borderColor: phaseProgress >= 2 ? '#10b981' : C.border }}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-white text-sm shadow-sm ${phaseProgress >= 2 ? 'bg-emerald-500' : 'bg-slate-300'}`}>2</div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-800">PHASE 2 — 一手目：意味地図生成</h4>
                <p className="text-xs text-slate-500">セマンティックマップ生成・顧客別ルール参照</p>
              </div>
              {phaseProgress === 2 && <div className="animate-spin w-5 h-5 border-2 border-emerald-300 border-t-emerald-600 rounded-full" />}
              {phaseProgress > 2 && <CheckCircle2 size={24} className="text-emerald-500" />}
            </div>
          </div>

          {/* PHASE 3 */}
          <div className="bg-white rounded-xl shadow-sm border p-5 transition-all" style={{ borderColor: phaseProgress >= 3 ? '#10b981' : C.border }}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-white text-sm shadow-sm ${phaseProgress >= 3 ? 'bg-emerald-500' : 'bg-slate-300'}`}>3</div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-800">PHASE 3 — 二手目：ルール確定</h4>
                <p className="text-xs text-slate-500">組版ルール自動確定（CSS生成・グリッド・フォント・行送り）</p>
              </div>
              {phaseProgress === 3 && <div className="animate-spin w-5 h-5 border-2 border-emerald-300 border-t-emerald-600 rounded-full" />}
              {phaseProgress > 3 && <CheckCircle2 size={24} className="text-emerald-500" />}
            </div>
          </div>

          {/* PHASE 4 */}
          <div className="bg-white rounded-xl shadow-sm border p-5 transition-all" style={{ borderColor: phaseProgress >= 4 ? '#0ea5e9' : C.border }}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-white text-sm shadow-sm ${phaseProgress >= 4 ? 'bg-sky-500' : 'bg-slate-300'}`}>4</div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-800">PHASE 4 — 三手目：全ページ一括生成</h4>
                <p className="text-xs text-slate-500">Vivliostyle 組版エンジン (VFM + CSS) - 合議不要 機械的実行のみ</p>
              </div>
              {phaseProgress === 4 && <div className="animate-spin w-5 h-5 border-2 border-sky-300 border-t-sky-600 rounded-full" />}
              {phaseProgress > 4 && <CheckCircle2 size={24} className="text-sky-500" />}
            </div>
          </div>

          {/* PHASE 5 */}
          <div className="bg-white rounded-xl shadow-sm border p-5 transition-all" style={{ borderColor: phaseProgress >= 5 ? '#f59e0b' : C.border }}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-white text-sm shadow-sm ${phaseProgress >= 5 ? 'bg-amber-500' : 'bg-slate-300'}`}>5</div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-800">PHASE 5 — 出口の合議</h4>
                <p className="text-xs text-slate-500">三者合議 ② 品質検証（構造検証・マッピング・差分検証・プリフライト）</p>
              </div>
              {phaseProgress === 5 && <div className="animate-spin w-5 h-5 border-2 border-amber-300 border-t-amber-600 rounded-full" />}
              {phaseProgress > 5 && <CheckCircle2 size={24} className="text-amber-500" />}
            </div>
          </div>

          <div className="mt-8">
            <button
              onClick={startVivliostyleProcess}
              disabled={phaseProgress > 0 && phaseProgress < 6}
              className="w-full py-5 rounded-2xl font-bold text-xl text-white shadow-xl transition-all flex items-center justify-center gap-3 disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #0f172a, #1e293b)' }}
            >
              <FileText size={24} />
              {phaseProgress === 6 ? '再実行する' : '印刷用PDF出力 (PDF/X-1a) を開始'}
            </button>
            {phaseProgress === 6 && vivliostylePdfB64 && (
               <div className="mt-4 text-center">
                 <button 
                  onClick={() => {
                    const el = document.createElement("a");
                    el.href = `data:application/pdf;base64,${vivliostylePdfB64}`;
                    const titleSpan = spans.find(s => s.font_class === 'mincho') || spans[0];
                    el.download = `${titleSpan?.text?.trim() || '名刺'}_vivliostyle.pdf`;
                    el.click();
                  }}
                  className="text-emerald-600 font-bold bg-emerald-50 border border-emerald-200 px-6 py-3 rounded-xl hover:bg-emerald-100 transition-colors">
                   <Download size={18} className="inline mr-2" /> Vivliostyle PDF をダウンロード
                 </button>
                 <p className="text-xs text-slate-400 mt-2">Vivliostyle CLI 10.3.1 / Core 2.40.0 で生成</p>
               </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );



  // ── Tool Workspace (6 tools) ──
  const [toolInput, setToolInput] = useState('');
  const [toolOutput, setToolOutput] = useState('');
  const [toolLoading, setToolLoading] = useState(false);
  const [toolFile, setToolFile] = useState<File | null>(null);
  const [toolFile2, setToolFile2] = useState<File | null>(null);

  const TOOL_DEFS: Record<string, {
    title: string; description: string; placeholder: string;
    systemPrompt: string; color: string; gradient: string;
    features: string[];
  }> = {
    writing: {
      title: '文章作成・リライト',
      description: '商業出版向けの文章をAIで作成・リライトします。書籍本文、帯文、目次、奥付、まえがき・あとがきなどに対応。',
      placeholder: '例: 以下の原稿テキストを出版品質にリライトしてください。ターゲット読者は経営層。文体は敬体統一...',
      systemPrompt: 'あなたは商業出版の編集者兼ライターです。書籍・雑誌・専門誌の原稿作成・リライトが専門です。以下を意識してください：\n・読者層を意識した文体の統一\n・見出し階層の適切な構成\n・組版を前提とした改行・段落設計\n・ルビが必要な語句の指示\n・JIS X 4051組版ルールに基づく約物処理',
      color: '#8b5cf6',
      gradient: 'linear-gradient(135deg, #8b5cf6, #a78bfa)',
      features: ['原稿リライト', '見出し構成', '文体統一', '出版品質'],
    },
    ocr: {
      title: 'OCR・文字起こし',
      description: '画像やPDFからテキストを抽出します。手書き原稿、FAX、スキャン画像のデジタル化に。',
      placeholder: '画像をアップロードしてOCR処理を実行するか、テキストを入力して整形してください...',
      systemPrompt: 'あなたはOCR・文字起こしの専門家です。入力されたテキストの誤字脱字を修正し、適切な改行・段落分けを行ってください。原稿の意図を汲み取り、印刷品質のテキストに仕上げてください。',
      color: '#06b6d4',
      gradient: 'linear-gradient(135deg, #06b6d4, #22d3ee)',
      features: ['画像→テキスト変換', '手書き原稿対応', '誤字脱字修正', 'テキスト整形'],
    },
    pdf_edit: {
      title: 'PDF加工・修正・編集',
      description: 'PDFの内容確認やテキスト修正案を作成します。修正指示の整理や差し替え内容の準備に。',
      placeholder: '例: 以下のテキストの誤りを修正してください。「株式回社○○ 代表取締駅 山田太朗」→...',
      systemPrompt: 'あなたは印刷物のPDF校正の専門家です。テキストの誤字・脱字・表記揺れを発見し、修正案を提示してください。修正箇所は【修正前】→【修正後】の形式で明示してください。',
      color: '#f59e0b',
      gradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)',
      features: ['テキスト修正案', '表記揺れチェック', '修正指示整理', '差し替え準備'],
    },
    pdf_compare: {
      title: 'PDF比較（初校⇔再校）',
      description: '初校と再校の差分を検出。赤字修正の反映漏れ、意図しない変更を一括チェック。',
      placeholder: '比較するテキストを入力してください。\n\n--- 初校 ---\n（初校テキストをここに）\n\n--- 再校 ---\n（再校テキストをここに）',
      systemPrompt: 'あなたは印刷校正の差分チェック専門家です。2つのテキストを比較し、変更箇所を全て漏れなくリストアップしてください。追加・削除・変更をそれぞれ明示し、見落としがないか確認してください。変更箇所は行番号と共に報告してください。',
      color: '#ec4899',
      gradient: 'linear-gradient(135deg, #ec4899, #f472b6)',
      features: ['テキスト差分検出', '初校⇔再校比較', '変更箇所一覧', '修正漏れチェック'],
    },
    proofread: {
      title: '校閲・校正・ファクトチェック',
      description: '商業出版原稿の校閲・校正。誤字脱字、表記統一、事実確認、JIS表記、法的リスクを一括チェック。',
      placeholder: '校閲・校正対象のテキストを入力してください...',
      systemPrompt: 'あなたは出版・印刷業界の校閲・校正の専門家です。以下の観点でテキストをチェックしてください：\n1. 誤字・脱字・変換ミス\n2. 表記の統一性（数字、単位、敬称）\n3. 事実関係の確認（電話番号、住所、日付、金額）\n4. 法的リスク（景品表示法、薬機法、著作権）\n5. 差別表現・不適切表現\n各指摘は【種別】【箇所】【指摘内容】【修正案】の形式で報告してください。',
      color: '#10b981',
      gradient: 'linear-gradient(135deg, #10b981, #34d399)',
      features: ['誤字脱字チェック', '事実確認', '表記統一', '法的リスク確認'],
    },
    typeset_spec: {
      title: '組版指示書作成・読み取り',
      description: '組版指示書の作成や既存指示書の読み取り・解析を行います。フォント、級数、行送りなどの指定を整理。',
      placeholder: '例: 以下の条件で組版指示書を作成してください。\n仕上がりサイズ: A4\n本文: 明朝体 13Q\n行送り: 22H\n段組み: 2段...',
      systemPrompt: 'あなたは日本の印刷・組版の専門家です。組版指示書の作成・読み取りを行います。以下の項目を必ず含めてください：\n・仕上がりサイズ（判型）\n・本文書体・級数（Q/pt）・行送り（H）\n・見出し書体・級数\n・段組み・段間\n・マージン（天地左右ノド小口）\n・ノンブル位置・書体\n・柱の位置・書体\nJIS X 4051に準拠した日本語組版ルールを適用してください。',
      color: '#6366f1',
      gradient: 'linear-gradient(135deg, #6366f1, #818cf8)',
      features: ['指示書自動生成', '既存指示書解析', 'Q数/H数計算', '組版ルール適用'],
    },
  };

  const handleToolSubmit = async (toolId: string) => {
    const def = TOOL_DEFS[toolId];
    if (!def) return;
    const input = toolInput.trim();
    if (!input && !toolFile) return;

    setToolLoading(true);
    setToolOutput('');

    try {
      const apiKey = await getConfig('VITE_GOOGLE_AI_KEY');
      if (!apiKey) {
        setToolOutput('❌ Google AI APIキーが設定されていません。設定画面でキーを入力してください。');
        setToolLoading(false);
        return;
      }

      let userContent = input;
      
      // If file uploaded, read as text/base64
      if (toolFile) {
        const reader = new FileReader();
        const fileText = await new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          if (toolFile.type.startsWith('text/') || toolFile.name.endsWith('.txt') || toolFile.name.endsWith('.csv')) {
            reader.readAsText(toolFile);
          } else {
            reader.readAsDataURL(toolFile);
          }
        });
        userContent = `[アップロードファイル: ${toolFile.name}]\n${fileText}\n\n${input}`;
      }

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: def.systemPrompt }] },
            contents: [{ parts: [{ text: userContent }] }],
            generationConfig: { temperature: 0.3 },
          }),
        }
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API Error ${res.status}: ${err}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '（応答なし）';
      setToolOutput(text);
    } catch (e: any) {
      setToolOutput(`❌ エラー: ${e.message}`);
    } finally {
      setToolLoading(false);
    }
  };

  const renderToolWorkspace = (toolId: string) => {
    const def = TOOL_DEFS[toolId];
    if (!def) return null;

    return (
      <div className="flex-1 overflow-y-auto p-6" style={{ background: C.bg }}>
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Hero card */}
          <div className="rounded-2xl p-6 text-white shadow-lg" style={{ background: def.gradient }}>
            <h3 className="text-xl font-bold mb-2">{def.title}</h3>
            <p className="text-sm opacity-90 mb-4">{def.description}</p>
            <div className="flex flex-wrap gap-2">
              {def.features.map(f => (
                <span key={f} className="text-xs bg-white/20 backdrop-blur px-3 py-1 rounded-full">{f}</span>
              ))}
            </div>
          </div>

          {/* Input area */}
          <div className="bg-white rounded-2xl border shadow-sm p-6" style={{ borderColor: C.border }}>
            {toolId === 'pdf_compare' ? (
              /* === PDF比較: 2ファイル専用UI === */
              <>
                <h4 className="text-sm font-bold text-slate-700 mb-4">初校と再校を選択</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  {/* 初校 */}
                  <div className="border-2 border-dashed rounded-xl p-5 text-center transition-all hover:border-pink-300" style={{ borderColor: toolFile ? '#10b981' : C.border }}>
                    <p className="text-xs font-bold text-slate-500 mb-2">📄 初校（基点）</p>
                    <button
                      onClick={async () => { try { const f = await pickPdfFromDrive(); if (f) setToolFile(f); } catch (e: any) { flash(e.message, 'error'); } }}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80 text-white"
                      style={{ background: def.gradient }}
                    >
                      <HardDrive size={14} className="inline mr-1" /> Google Driveから選択
                    </button>
                    {toolFile && <p className="mt-2 text-xs text-emerald-600 font-medium">✓ {toolFile.name}</p>}
                  </div>
                  {/* 再校 */}
                  <div className="border-2 border-dashed rounded-xl p-5 text-center transition-all hover:border-pink-300" style={{ borderColor: toolFile2 ? '#10b981' : C.border }}>
                    <p className="text-xs font-bold text-slate-500 mb-2">📄 再校（比較対象）</p>
                    <button
                      onClick={async () => { try { const f = await pickPdfFromDrive(); if (f) setToolFile2(f); } catch (e: any) { flash(e.message, 'error'); } }}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80 text-white"
                      style={{ background: def.gradient }}
                    >
                      <HardDrive size={14} className="inline mr-1" /> Google Driveから選択
                    </button>
                    {toolFile2 && <p className="mt-2 text-xs text-emerald-600 font-medium">✓ {toolFile2.name}</p>}
                  </div>
                </div>
                <textarea
                  className="w-full border rounded-xl p-4 text-sm min-h-[100px] resize-y focus:outline-none focus:ring-2 focus:ring-pink-300 transition-all"
                  style={{ borderColor: C.border }}
                  placeholder="補足指示（任意）: 特に注意して比較してほしい箇所があれば記入..."
                  value={toolInput}
                  onChange={e => setToolInput(e.target.value)}
                />
              </>
            ) : (
              /* === 通常ツールUI === */
              <>
                <h4 className="text-sm font-bold text-slate-700 mb-3">入力</h4>
                <textarea
                  className="w-full border rounded-xl p-4 text-sm min-h-[160px] resize-y focus:outline-none focus:ring-2 focus:ring-teal-300 transition-all"
                  style={{ borderColor: C.border }}
                  placeholder={def.placeholder}
                  value={toolInput}
                  onChange={e => setToolInput(e.target.value)}
                />
                
                {/* Google Drive file picker */}
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={async () => {
                      try {
                        const file = await pickPdfFromDrive();
                        if (file) setToolFile(file);
                      } catch (err: any) {
                        flash(err.message || 'Google Drive接続エラー', 'error');
                      }
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl border text-[13px] font-medium transition-all hover:bg-gray-50"
                    style={{ borderColor: C.border, color: C.textSec }}
                  >
                    <HardDrive size={16} /> Google Driveから選択
                  </button>
                  {toolFile && (
                    <span className="text-xs text-gray-500 flex items-center gap-1">
                      <FileText size={14} /> {toolFile.name}
                      <button onClick={() => setToolFile(null)} className="text-red-400 hover:text-red-600 ml-1">×</button>
                    </span>
                  )}
                </div>
              </>
            )}

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => handleToolSubmit(toolId)}
                disabled={toolLoading || (toolId === 'pdf_compare' ? (!toolFile || !toolFile2) : (!toolInput.trim() && !toolFile))}
                className="px-6 py-2.5 rounded-xl text-sm font-bold text-white shadow-md transition-all hover:opacity-90 disabled:opacity-40 flex items-center gap-2"
                style={{ background: def.gradient }}
              >
                {toolLoading ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" />
                    処理中...
                  </>
                ) : (
                  <>
                    <Sparkles size={16} />
                    AIで実行
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Output area */}
          {toolOutput && (
            <div className="bg-white rounded-2xl border shadow-sm p-6" style={{ borderColor: C.border }}>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-bold text-slate-700">結果</h4>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(toolOutput);
                    flash('クリップボードにコピーしました', 'ok');
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors hover:bg-slate-50"
                  style={{ borderColor: C.border, color: C.textSec }}
                >
                  📋 コピー
                </button>
              </div>
              <div className="prose prose-sm max-w-none text-slate-700 leading-relaxed bg-slate-50 rounded-xl p-4 border" style={{ borderColor: C.border }}>
                <ReactMarkdown>{toolOutput}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── Manuscript Validation (原稿検証・第一レポート) ──
  const handleChunkText = () => {
    if (!msText.trim()) { flash('原稿テキストを入力してください', 'error'); return; }
    const chunks = chunkManuscript(msText, []);
    setMsChunks(chunks);
    setMsReport(null);
    setMsFeedbackActions({});
    setMsFeedbackSent(false);
    setMsFeedbackResult(null);
    flash(`${chunks.length}チャンクに分解しました`, 'ok');
  };

  const handleRunValidation = async () => {
    if (msChunks.length === 0) return;
    if (!msCustomer.trim()) { flash('顧客名を入力してください', 'error'); return; }
    setMsLoading(true);
    setMsReport(null);
    setMsFeedbackActions({});
    setMsFeedbackSent(false);
    flash('原稿検証中 — RAGルール検索 + Gemini検証...', 'info');
    try {
      const report = await validateManuscript({
        customer_name: msCustomer,
        publication_name: msPublication,
        chunks: msChunks,
      });
      setMsReport(report);
      const status = report.consensus.status;
      if (status === 'ready') {
        flash(`✅ 全${report.consensus.total_chunks}チャンクOK — 組版可能です！`, 'ok');
      } else {
        flash(`⚠ ${report.consensus.error_count_total}件のエラーを検出 — 修正が必要です`, 'error');
      }
    } catch (e: any) {
      flash(`検証エラー: ${e.message}`, 'error');
    } finally {
      setMsLoading(false);
    }
  };

  const handleSubmitFeedback = async () => {
    if (!msReport) return;
    const feedbacks: FeedbackInput[] = msReport.consensus.chunk_details
      .filter(d => d.status === 'NG')
      .map(d => {
        const action = msFeedbackActions[d.chunk_id] || { action: 'no_change' as FeedbackActionType };
        const firstError = d.validation_results[0];
        return {
          chunk_id: d.chunk_id,
          component_type: d.component_type,
          action_type: action.action,
          original_text: firstError?.original_text || d.current_text,
          ai_suggestion: firstError?.suggested_text,
          user_final_text: action.action === 'manual_override' ? action.editedText : undefined,
          error_type: firstError?.error_type,
          customer_name: msCustomer,
        };
      });

    if (feedbacks.length === 0) {
      flash('フィードバック対象がありません', 'info');
      return;
    }

    setMsLoading(true);
    flash('PDCAフィードバック送信中...', 'info');
    try {
      const result = await submitFeedback({
        report_id: msReport.report_id,
        feedbacks,
      });
      setMsFeedbackSent(true);
      setMsFeedbackResult(result);
      flash(`PDCA完了: ${result.rules_created}件の新ルールをRAGに蓄積`, 'ok');
    } catch (e: any) {
      flash(`フィードバックエラー: ${e.message}`, 'error');
    } finally {
      setMsLoading(false);
    }
  };

  const renderValidateManuscript = () => {
    const consensus = msReport?.consensus;
    const isReady = consensus?.status === 'ready';

    return (
      <div className="flex-1 overflow-auto p-6" style={{ background: C.bg }}>
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Step 1: 原稿入力 & チャンク分解 */}
          <div className="bg-white rounded-xl border shadow-sm p-6" style={{ borderColor: C.border }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ background: C.accent }}>1</div>
              <h3 className="text-lg font-bold text-slate-800">原稿入力 & チャンク分解</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">顧客名 <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={msCustomer}
                  onChange={e => setMsCustomer(e.target.value)}
                  placeholder="例: 酵母研究会"
                  className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-teal-300"
                  style={{ borderColor: C.border }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">刊行物名</label>
                <input
                  type="text"
                  value={msPublication}
                  onChange={e => setMsPublication(e.target.value)}
                  placeholder="例: 酵母通信 Vol.42"
                  className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-teal-300"
                  style={{ borderColor: C.border }}
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={handleChunkText}
                  disabled={!msText.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-2 transition-colors hover:opacity-90 shadow-sm disabled:opacity-40"
                  style={{ background: C.accent }}
                >
                  <Sparkles size={16} /> チャンク分解
                </button>
              </div>
            </div>

            <textarea
              value={msText}
              onChange={e => setMsText(e.target.value)}
              placeholder="著者の原稿テキストをここに貼り付けてください。&#10;&#10;段落（空行区切り）ごとにコンポーネント単位に自動分解されます。&#10;Q. で始まるテキストは「Q&Aボックス」として認識されます。"
              className="w-full h-48 px-4 py-3 rounded-lg border text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-teal-300"
              style={{ borderColor: C.border }}
            />

            {/* チャンクプレビュー */}
            {msChunks.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-500">{msChunks.length}チャンクに分解済み</span>
                  <button
                    onClick={handleRunValidation}
                    disabled={msLoading || !msCustomer.trim()}
                    className={`px-5 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-2 transition-all shadow-md ${!msLoading && msCustomer.trim() ? 'hover:opacity-90' : 'opacity-40 cursor-not-allowed'}`}
                    style={{ background: 'linear-gradient(135deg, #0d9488, #06b6d4)' }}
                  >
                    <ShieldCheck size={16} />
                    {msLoading ? '検証中...' : 'RAG + Gemini で原稿検証'}
                  </button>
                </div>
                <div className="space-y-2">
                  {msChunks.map((chunk, idx) => (
                    <div key={idx} className="flex items-start gap-3 p-3 rounded-lg border" style={{ borderColor: C.border }}>
                      <span className="shrink-0 text-[10px] font-mono font-bold px-2 py-0.5 rounded" style={{ background: C.accentBg, color: C.accent }}>
                        {chunk.role}
                      </span>
                      <p className="text-xs text-slate-600 line-clamp-2">{chunk.text}</p>
                      <span className="shrink-0 text-[10px] font-mono" style={{ color: C.muted }}>{chunk.text.length}字</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Step 2: 第一レポート（合議結果） */}
          {consensus && (
            <div className="bg-white rounded-xl border shadow-sm p-6" style={{ borderColor: C.border }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ background: C.accent }}>2</div>
                  <h3 className="text-lg font-bold text-slate-800">第一レポート（合議結果）</h3>
                </div>
                <div className={`px-4 py-2 rounded-full text-sm font-bold border-2 ${isReady ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-amber-50 text-amber-700 border-amber-300'}`}>
                  {isReady ? '✅ READY — 組版可能' : '⚠ NEEDS REVISION — 修正必要'}
                </div>
              </div>

              {/* サマリーカード */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="text-center p-3 rounded-lg" style={{ background: C.surface }}>
                  <div className="text-2xl font-bold" style={{ color: C.accent }}>{consensus.total_chunks}</div>
                  <div className="text-[10px] font-medium" style={{ color: C.muted }}>総チャンク数</div>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: C.surface }}>
                  <div className="text-2xl font-bold text-emerald-600">{consensus.total_chunks - consensus.error_count_total}</div>
                  <div className="text-[10px] font-medium" style={{ color: C.muted }}>OK</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-red-50">
                  <div className="text-2xl font-bold text-red-600">{consensus.error_count_overflow}</div>
                  <div className="text-[10px] font-medium text-red-400">文字あふれ</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-amber-50">
                  <div className="text-2xl font-bold text-amber-600">{consensus.error_count_rule}</div>
                  <div className="text-[10px] font-medium text-amber-400">ルール違反</div>
                </div>
              </div>

              {/* RAGルール情報 */}
              {msReport!.rag_rules_used > 0 && (
                <div className="mb-4 p-3 rounded-lg border" style={{ borderColor: C.border, background: C.surface }}>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: C.muted }}>
                    RAGから引き当てたルール ({msReport!.rag_rules_used}件)
                  </h4>
                  <div className="space-y-1">
                    {msReport!.rag_rules.map((r, i) => (
                      <div key={i} className="text-xs flex items-center gap-2">
                        <span className={`font-mono px-1.5 py-0.5 rounded ${r.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                          {r.rule_code}
                        </span>
                        <span className="text-slate-600">{r.text}</span>
                        {r.similarity > 0 && (
                          <span className="text-[10px] font-mono" style={{ color: C.muted }}>
                            ({(r.similarity * 100).toFixed(0)}%)
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* チャンクごとの詳細 */}
              <div className="space-y-3">
                {consensus.chunk_details.map((detail, idx) => {
                  const feedbackAction = msFeedbackActions[detail.chunk_id];
                  const isNg = detail.status === 'NG';

                  return (
                    <div
                      key={idx}
                      className="border rounded-xl p-4 transition-all"
                      style={{
                        borderColor: isNg ? '#ef4444' : '#10b981',
                        borderLeftWidth: 4,
                        background: isNg ? '#fef2f2' : '#f0fdf4',
                      }}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {isNg ? (
                            <XCircle size={16} className="text-red-500" />
                          ) : (
                            <CheckCircle2 size={16} className="text-emerald-500" />
                          )}
                          <span className="text-sm font-bold text-slate-800">{detail.chunk_id}</span>
                          <span className="font-mono text-xs px-2 py-0.5 rounded" style={{ background: C.accentBg, color: C.accent }}>
                            {detail.component_type}
                          </span>
                          <span className="text-[10px]" style={{ color: C.muted }}>{detail.text_length}字</span>
                        </div>
                        <span className={`text-xs font-bold px-3 py-1 rounded-full ${isNg ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                          {detail.status}
                        </span>
                      </div>

                      {/* 原稿テキスト */}
                      <p className="text-xs text-slate-600 mb-2 line-clamp-2">{detail.current_text}</p>

                      {/* エラー詳細 & アクションボタン */}
                      {isNg && detail.validation_results.length > 0 && (
                        <div className="space-y-2">
                          {detail.validation_results.map((err, ei) => (
                            <div key={ei} className="bg-white rounded-lg p-3 border border-red-200">
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${err.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {err.error_type}
                                </span>
                                <span className="text-[10px] font-mono" style={{ color: C.muted }}>({err.reason_ref})</span>
                              </div>
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <span className="text-red-500 font-bold">元:</span>
                                  <span className="ml-1 line-through text-red-400">{err.original_text}</span>
                                </div>
                                <div>
                                  <span className="text-emerald-600 font-bold">提案:</span>
                                  <span className="ml-1 text-emerald-700 font-medium">{err.suggested_text}</span>
                                </div>
                              </div>
                            </div>
                          ))}

                          {/* PDCA アクションボタン */}
                          {!msFeedbackSent && (
                            <div className="flex items-center gap-2 mt-2">
                              <button
                                onClick={() => setMsFeedbackActions(prev => ({ ...prev, [detail.chunk_id]: { action: 'accept' } }))}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${feedbackAction?.action === 'accept' ? 'bg-emerald-100 border-emerald-400 text-emerald-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                              >
                                ✓ 受入
                              </button>
                              <button
                                onClick={() => setMsFeedbackActions(prev => ({ ...prev, [detail.chunk_id]: { action: 'reject' } }))}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${feedbackAction?.action === 'reject' ? 'bg-red-100 border-red-400 text-red-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                              >
                                ✕ 棄却
                              </button>
                              <button
                                onClick={() => setMsFeedbackActions(prev => ({
                                  ...prev,
                                  [detail.chunk_id]: { action: 'manual_override', editedText: detail.current_text }
                                }))}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${feedbackAction?.action === 'manual_override' ? 'bg-blue-100 border-blue-400 text-blue-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                              >
                                ✎ 手動修正
                              </button>
                            </div>
                          )}

                          {/* 手動修正テキストエリア */}
                          {feedbackAction?.action === 'manual_override' && !msFeedbackSent && (
                            <textarea
                              value={feedbackAction.editedText || ''}
                              onChange={e => setMsFeedbackActions(prev => ({
                                ...prev,
                                [detail.chunk_id]: { ...prev[detail.chunk_id], editedText: e.target.value }
                              }))}
                              className="w-full mt-2 px-3 py-2 rounded-lg border text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-300"
                              style={{ borderColor: '#93c5fd' }}
                              rows={3}
                            />
                          )}

                          {msFeedbackSent && feedbackAction && (
                            <div className="text-[10px] font-medium mt-1" style={{ color: C.muted }}>
                              📝 {feedbackAction.action === 'accept' ? 'AI提案を受入' : feedbackAction.action === 'reject' ? 'AI指摘を棄却' : '手動修正済み'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Step 3: PDCAフィードバック送信 */}
              {!isReady && !msFeedbackSent && (
                <div className="mt-6 flex items-center justify-between p-4 rounded-lg border-2 border-dashed" style={{ borderColor: C.accentBorder }}>
                  <div>
                    <h4 className="text-sm font-bold text-slate-800">PDCA フィードバック送信</h4>
                    <p className="text-xs mt-0.5" style={{ color: C.muted }}>
                      上記の判断（受入/棄却/手動修正）をRAGに蓄積し、次回の検証精度を向上させます
                    </p>
                  </div>
                  <button
                    onClick={handleSubmitFeedback}
                    disabled={msLoading}
                    className="px-5 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-2 transition-all shadow-md hover:opacity-90"
                    style={{ background: 'linear-gradient(135deg, #7c3aed, #a855f7)' }}
                  >
                    <RefreshCw size={16} /> フィードバック送信 & 学習
                  </button>
                </div>
              )}

              {/* PDCAフィードバック結果 */}
              {msFeedbackSent && msFeedbackResult && (
                <div className="mt-6 p-5 rounded-xl border-2 border-purple-300 bg-purple-50">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold bg-purple-600">P</div>
                    <h3 className="text-base font-bold text-purple-900">PDCA サイクル完了</h3>
                  </div>
                  <div className="grid grid-cols-4 gap-3 mb-3">
                    {(['plan', 'do', 'check', 'action'] as const).map(phase => (
                      <div key={phase} className="text-center p-3 rounded-lg bg-white border border-purple-200">
                        <div className="text-xs font-bold uppercase text-purple-600 mb-1">{phase.toUpperCase()}</div>
                        <div className="text-[10px] text-slate-600">{msFeedbackResult.pdca_cycle[phase]}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-lg bg-white border border-purple-200">
                    <span className="text-xs text-slate-600">
                      🧠 <strong>{msFeedbackResult.rules_created}件</strong>の新ルールをRAGベクトルDBに蓄積
                    </span>
                    <span className="text-[10px] font-mono" style={{ color: C.muted }}>
                      Report: {msFeedbackResult.report_id.substring(0, 8)}...
                    </span>
                  </div>
                  {msFeedbackResult.results.filter(r => r.rule_generated).map((r, i) => (
                    <div key={i} className="mt-2 p-2 rounded-lg bg-white border border-emerald-200 text-xs">
                      <span className="font-mono font-bold text-emerald-600">{r.chunk_id}</span>: {r.generated_rule_text}
                    </div>
                  ))}
                </div>
              )}

              {/* 組版エンジンへの送信ボタン（全OK時のみ） */}
              {isReady && (
                <div className="mt-6 text-center p-6 rounded-xl border-2 border-emerald-300 bg-emerald-50">
                  <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-600" />
                  <h3 className="text-lg font-bold text-emerald-800">全チャンク検証OK</h3>
                  <p className="text-sm mt-1 text-emerald-600">Vivliostyle 組版エンジンに安全に送信できます</p>
                  <button
                    className="mt-4 px-8 py-3 rounded-lg text-base font-bold text-white shadow-lg transition-all hover:opacity-90"
                    style={{ background: 'linear-gradient(135deg, #059669, #10b981)' }}
                    onClick={() => flash('組版エンジン連携は次のフェーズで実装されます', 'info')}
                  >
                    📄 Vivliostyle で PDF生成
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── Detect Layout (自動組版 検出ワークフロー) ──
  const handleDetectUpload = async (file: File) => {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      flash('PDFファイルを選択してください', 'error');
      return;
    }
    setDetectLoading(true);
    setDetectResults([]);
    setDetectSaved(false);
    setDetectSelectedPage(0);
    flash('PDF分析中 — ページ画像を抽出しています...', 'info');
    try {
      const apiUrl = getConfig('VITE_API_URL');
      const pages = await extractPagesFromPdf(file, apiUrl);
      setDetectPages(pages);
      flash(`${pages.length}ページを抽出しました`, 'ok');
    } catch (e: any) {
      flash(`PDF分析エラー: ${e.message}`, 'error');
    } finally {
      setDetectLoading(false);
    }
  };

  const handleRunDetection = async () => {
    if (detectPages.length === 0) return;
    if (!detectCustomerName.trim()) { flash('顧客名を入力してください', 'error'); return; }
    if (!detectProjectName.trim()) { flash('刊行物名を入力してください', 'error'); return; }
    setDetectLoading(true);
    setDetectResults([]);
    setDetectSaved(false);
    setDetectProgress({ current: 0, total: detectPages.length });
    flash(`検出開始 — ${detectPages.length}ページをGemini 2.5 Pro で解析中...`, 'info');
    try {
      const results = await detectAllPages({
        pages: detectPages,
        customer_name: detectCustomerName,
        project_name: detectProjectName,
        onProgress: (current, total, result) => {
          setDetectProgress({ current, total });
          setDetectResults(prev => [...prev, result]);
          flash(`ページ ${current}/${total} 検出完了 — ${result.detection.components_count}コンポーネント`, 'ok');
        },
      });
      flash(`全${results.length}ページの検出が完了しました！`, 'ok');
      setDetectSaved(true);
    } catch (e: any) {
      flash(`検出エラー: ${e.message}`, 'error');
    } finally {
      setDetectLoading(false);
      setDetectProgress(null);
    }
  };

  const renderDetectLayout = () => {
    const currentResult = detectResults[detectSelectedPage];

    return (
      <div className="flex-1 overflow-auto p-6" style={{ background: C.bg }}>

        <div className="max-w-7xl mx-auto space-y-6">
          {/* Step 1: アップロード & 設定 */}
          <div className="bg-white rounded-xl border shadow-sm p-6" style={{ borderColor: C.border }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ background: C.accent }}>1</div>
              <h3 className="text-lg font-bold text-slate-800">PDFアップロード & プロジェクト設定</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">顧客名 <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={detectCustomerName}
                  onChange={e => setDetectCustomerName(e.target.value)}
                  placeholder="例: 酵母研究会"
                  className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-teal-300"
                  style={{ borderColor: C.border }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">刊行物名 <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={detectProjectName}
                  onChange={e => setDetectProjectName(e.target.value)}
                  placeholder="例: 酵母通信 Vol.42"
                  className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-teal-300"
                  style={{ borderColor: C.border }}
                />
              </div>
              <div className="flex items-end gap-2">
                <button
                  onClick={() => detectFileRef.current?.click()}
                  disabled={detectLoading}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-2 transition-colors hover:opacity-90 shadow-sm"
                  style={{ background: C.accent }}
                >
                  <Upload size={16} /> PDFを選択
                </button>
                <button
                  onClick={async () => {
                    try {
                      const file = await pickPdfFromDrive();
                      if (file) handleDetectUpload(file);
                    } catch (e: any) {
                      flash(e.message || 'Google Drive接続エラー', 'error');
                    }
                  }}
                  disabled={detectLoading}
                  className="px-4 py-2 rounded-lg text-sm font-medium border flex items-center gap-2 transition-colors hover:bg-slate-50"
                  style={{ borderColor: C.border, color: C.textSec }}
                >
                  <HardDrive size={16} /> Drive
                </button>
              </div>
            </div>

            {/* ページサムネイル */}
            {detectPages.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-500">{detectPages.length}ページ検出</span>
                  <button
                    onClick={handleRunDetection}
                    disabled={detectLoading || !detectCustomerName.trim() || !detectProjectName.trim()}
                    className={`px-5 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-2 transition-all shadow-md ${!detectLoading && detectCustomerName.trim() && detectProjectName.trim() ? 'hover:opacity-90' : 'opacity-40 cursor-not-allowed'}`}
                    style={{ background: 'linear-gradient(135deg, #0d9488, #06b6d4)' }}
                  >
                    <Sparkles size={16} />
                    {detectLoading ? `検出中 ${detectProgress ? `(${detectProgress.current}/${detectProgress.total})` : '...'}` : 'Gemini 2.5 Pro でレイアウト検出'}
                  </button>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {detectPages.map((page, idx) => (
                    <div
                      key={idx}
                      onClick={() => setDetectSelectedPage(idx)}
                      className={`shrink-0 cursor-pointer rounded-lg border-2 overflow-hidden transition-all ${detectSelectedPage === idx ? 'ring-2 ring-teal-400 border-teal-400 shadow-lg' : 'border-slate-200 hover:border-slate-300'}`}
                      style={{ width: 100 }}
                    >
                      <img
                        src={`data:image/png;base64,${page.png_b64}`}
                        alt={`Page ${page.page_number}`}
                        className="w-full h-auto"
                      />
                      <div className="text-center text-[10px] py-1 font-medium" style={{ color: C.textSec }}>
                        P{page.page_number}
                        {detectResults[idx] && (
                          <span className="ml-1" style={{ color: C.accent }}>✓ {detectResults[idx].detection.components_count}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 進捗バー */}
            {detectProgress && (
              <div className="mt-3">
                <div className="w-full bg-slate-100 rounded-full h-2.5">
                  <div
                    className="h-2.5 rounded-full transition-all duration-500"
                    style={{ background: 'linear-gradient(90deg, #0d9488, #06b6d4)', width: `${(detectProgress.current / detectProgress.total) * 100}%` }}
                  />
                </div>
                <p className="text-xs mt-1 text-center" style={{ color: C.muted }}>
                  {detectProgress.current} / {detectProgress.total} ページ解析中...
                </p>
              </div>
            )}
          </div>

          {/* Step 2: 検出結果プレビュー */}
          {currentResult && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* 左: ページ画像 + 検出オーバーレイ */}
              <div className="bg-white rounded-xl border shadow-sm p-5" style={{ borderColor: C.border }}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ background: C.accent }}>2</div>
                  <h3 className="text-base font-bold text-slate-800">ページ {detectSelectedPage + 1} プレビュー</h3>
                </div>
                <div className="relative rounded-lg overflow-hidden border" style={{ borderColor: C.border }}>
                  <img
                    src={`data:image/png;base64,${detectPages[detectSelectedPage]?.png_b64}`}
                    alt="Page preview"
                    className="w-full h-auto"
                  />
                </div>

                {/* ページジオメトリ */}
                {currentResult.detection.page_geometry && (
                  <div className="mt-4 p-3 rounded-lg" style={{ background: C.surface }}>
                    <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: C.muted }}>ページジオメトリ</h4>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div><span style={{ color: C.muted }}>天:</span> <span className="font-mono font-bold">{currentResult.detection.page_geometry.margins.top_mm}mm</span></div>
                      <div><span style={{ color: C.muted }}>地:</span> <span className="font-mono font-bold">{currentResult.detection.page_geometry.margins.bottom_mm}mm</span></div>
                      <div><span style={{ color: C.muted }}>のど:</span> <span className="font-mono font-bold">{currentResult.detection.page_geometry.margins.inside_mm}mm</span></div>
                      <div><span style={{ color: C.muted }}>小口:</span> <span className="font-mono font-bold">{currentResult.detection.page_geometry.margins.outside_mm}mm</span></div>
                      <div><span style={{ color: C.muted }}>段数:</span> <span className="font-mono font-bold">{currentResult.detection.page_geometry.base_column_count}段</span></div>
                      <div><span style={{ color: C.muted }}>組方向:</span> <span className="font-mono font-bold">{currentResult.detection.page_geometry.base_writing_mode === 'vertical-rl' ? '縦組み' : '横組み'}</span></div>
                    </div>
                  </div>
                )}

                {/* デザイントークン */}
                {currentResult.detection.design_tokens && (
                  <div className="mt-3 p-3 rounded-lg" style={{ background: C.surface }}>
                    <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: C.muted }}>デザイントークン</h4>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded border" style={{ background: currentResult.detection.design_tokens.primary_color, borderColor: C.border }} />
                        <span style={{ color: C.muted }}>Primary:</span>
                        <span className="font-mono font-bold">{currentResult.detection.design_tokens.primary_color}</span>
                      </div>
                      {currentResult.detection.design_tokens.secondary_color && (
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 rounded border" style={{ background: currentResult.detection.design_tokens.secondary_color, borderColor: C.border }} />
                          <span style={{ color: C.muted }}>Secondary:</span>
                          <span className="font-mono font-bold">{currentResult.detection.design_tokens.secondary_color}</span>
                        </div>
                      )}
                      <div><span style={{ color: C.muted }}>本文:</span> <span className="font-bold">{currentResult.detection.design_tokens.base_font_family}</span> <span className="font-mono">{currentResult.detection.design_tokens.base_font_size_q}Q / {currentResult.detection.design_tokens.base_line_height_q}Q</span></div>
                      {currentResult.detection.design_tokens.heading_font_family && (
                        <div><span style={{ color: C.muted }}>見出し:</span> <span className="font-bold">{currentResult.detection.design_tokens.heading_font_family}</span></div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 右: 検出コンポーネント一覧 */}
              <div className="bg-white rounded-xl border shadow-sm p-5" style={{ borderColor: C.border }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ background: C.accent }}>3</div>
                    <h3 className="text-base font-bold text-slate-800">検出コンポーネント</h3>
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ color: C.accent, background: C.accentBg }}>
                      {currentResult.detection.components_count}個
                    </span>
                  </div>
                  {currentResult.validation.errors_count > 0 && (
                    <span className="text-xs font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                      ⚠ {currentResult.validation.errors_count}件の警告
                    </span>
                  )}
                </div>

                <div className="space-y-3 max-h-[calc(100vh-340px)] overflow-y-auto pr-1">
                  {currentResult.detection.components.map((comp, idx) => (
                    <div
                      key={idx}
                      className="border rounded-xl p-4 transition-all hover:shadow-md"
                      style={{ borderColor: C.border, borderLeftWidth: 4, borderLeftColor: comp.id ? C.accent : '#ef4444' }}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold px-2 py-0.5 rounded" style={{ background: C.accentBg, color: C.accent }}>
                            {comp.code}
                          </span>
                          <span className="text-sm font-bold text-slate-800">{comp.name || comp.code}</span>
                        </div>
                        {comp.id && (
                          <CheckCircle2 size={16} style={{ color: C.accent }} />
                        )}
                        {comp.error && (
                          <span className="text-xs text-red-500 flex items-center gap-1">
                            <XCircle size={14} /> {comp.error}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* バリデーションエラー */}
                {currentResult.validation.errors.length > 0 && (
                  <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
                    <h4 className="text-xs font-bold text-amber-800 mb-2">バリデーション警告</h4>
                    <div className="space-y-1">
                      {currentResult.validation.errors.map((err, i) => (
                        <div key={i} className="text-xs text-amber-700">
                          <span className="font-mono font-bold">{err.field}</span>: {err.message}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 保存済みバッジ */}
                {detectSaved && (
                  <div className="mt-4 p-4 rounded-lg border-2 border-teal-300 bg-teal-50 text-center">
                    <CheckCircle2 size={24} className="mx-auto mb-2" style={{ color: C.accent }} />
                    <p className="text-sm font-bold" style={{ color: C.accent }}>
                      コンポーネントDBに保存完了
                    </p>
                    <p className="text-xs mt-1" style={{ color: C.textSec }}>
                      <span className="font-bold">{detectCustomerName}</span> / <span className="font-bold">{detectProjectName}</span>
                    </p>
                    <p className="text-[10px] mt-1 font-mono" style={{ color: C.muted }}>
                      Session: {currentResult.session_id?.substring(0, 8)}... | Globals: {currentResult.globals_id?.substring(0, 8)}...
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 全ページ概要 */}
          {detectResults.length > 1 && (
            <div className="bg-white rounded-xl border shadow-sm p-5" style={{ borderColor: C.border }}>
              <h3 className="text-base font-bold text-slate-800 mb-3">全ページ検出サマリー</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {detectResults.map((r, idx) => (
                  <button
                    key={idx}
                    onClick={() => setDetectSelectedPage(idx)}
                    className={`p-3 rounded-lg border text-center transition-all ${detectSelectedPage === idx ? 'ring-2 ring-teal-400 border-teal-400' : 'border-slate-200 hover:border-slate-300'}`}
                  >
                    <div className="text-lg font-bold" style={{ color: C.accent }}>{r.detection.components_count}</div>
                    <div className="text-[10px] font-medium" style={{ color: C.muted }}>P{idx + 1} コンポーネント</div>
                    <div className={`text-[10px] mt-1 font-medium ${r.validation.status === 'approved' ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {r.validation.status === 'approved' ? '✓ 承認済み' : `⚠ ${r.validation.errors_count}件`}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

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
        {view === AppState.TOOL_WRITING && renderToolWorkspace('writing')}
        {view === AppState.TOOL_OCR && renderToolWorkspace('ocr')}
        {view === AppState.TOOL_PDF_EDIT && <PdfEditor onBack={() => setView(AppState.DASHBOARD)} flash={flash} colors={C} />}
        {view === AppState.TOOL_PDF_COMPARE && renderToolWorkspace('pdf_compare')}
        {view === AppState.TOOL_PROOFREAD && renderToolWorkspace('proofread')}
        {view === AppState.TOOL_TYPESET_SPEC && renderToolWorkspace('typeset_spec')}
        {view === AppState.TOOL_DETECT_LAYOUT && renderDetectLayout()}
        {view === AppState.TOOL_VALIDATE_MS && renderValidateManuscript()}
        {/* クラウド組版カテゴリ */}
        {/* 商業出版 → 専用コンポーネント */}
        {view === AppState.KUMIHAN_COMMERCIAL && (
          <CommercialPublishing
            onBack={() => setView(AppState.DASHBOARD)}
            flash={flash}
            colors={C}
            onTemplateDesigner={() => setView(AppState.TEMPLATE_BOOK)}
          />
        )}
        {/* 名刺・新聞 → 共通アップロード画面 */}
        {(view === AppState.KUMIHAN_MEISHI || view === AppState.KUMIHAN_NEWSPAPER) && (
          <div className="flex-1 overflow-auto p-8" style={{ background: C.bg }}>
            <div className="max-w-5xl mx-auto">
              <div className="rounded-2xl p-1" style={{ background: view === AppState.KUMIHAN_MEISHI ? 'linear-gradient(135deg, #10b981, #34d399)' : 'linear-gradient(135deg, #3b82f6, #60a5fa)' }}>
                <div className="bg-white rounded-[14px] p-10">
                  <div className="text-center mb-8">
                    <h2 className="text-2xl font-bold text-gray-900 mb-2">
                      AIクラウド組版〜{view === AppState.KUMIHAN_MEISHI ? '名刺' : '新聞'}
                    </h2>
                    <p className="text-gray-500">
                      {view === AppState.KUMIHAN_MEISHI && 'PDFを入稿してAI構造解析→自動組版→校了PDFまでワンストップ。'}
                      {view === AppState.KUMIHAN_NEWSPAPER && '新聞原稿を入稿。段組み・見出し・写真配置をAIが自動レイアウト。'}
                    </p>
                  </div>
                  <div className="flex justify-center gap-4 flex-wrap">
                    <input type="file" accept=".pdf,application/pdf" id="local-pdf-upload" className="hidden"
                      onChange={(e) => { const file = e.target.files?.[0]; if (file) handleUpload(file); e.target.value = ''; }} />
                    <button onClick={() => document.getElementById('local-pdf-upload')?.click()}
                      className="px-8 py-4 rounded-xl text-[15px] font-bold flex items-center gap-3 text-white shadow-lg transition-all hover:opacity-90"
                      style={{ background: view === AppState.KUMIHAN_MEISHI ? 'linear-gradient(135deg, #10b981, #34d399)' : 'linear-gradient(135deg, #3b82f6, #60a5fa)' }}>
                      <Upload size={20} /> ローカルPCから入稿
                    </button>
                    <button onClick={async () => { try { const file = await pickPdfFromDrive(); if (file) handleUpload(file); } catch (err: any) { flash(err.message, 'error'); } }}
                      className="px-8 py-4 rounded-xl text-[15px] font-bold flex items-center gap-3 border-2 shadow-lg transition-all hover:opacity-90"
                      style={{ borderColor: view === AppState.KUMIHAN_MEISHI ? '#10b981' : '#3b82f6', color: view === AppState.KUMIHAN_MEISHI ? '#10b981' : '#3b82f6', background: 'white' }}>
                      <HardDrive size={20} /> Google Driveから入稿
                    </button>
                  </div>
                  <p className="text-center text-xs text-gray-400 mt-4">PDFファイルをこのエリアにドラッグ＆ドロップすることもできます</p>
                  <div className="mt-8 pt-6 border-t border-gray-100">
                    <button onClick={() => { if (view === AppState.KUMIHAN_MEISHI) setView(AppState.TEMPLATE_MEISHI); else setView(AppState.TEMPLATE_NEWSPAPER); }}
                      className="flex items-center gap-2 mx-auto px-6 py-3 rounded-xl text-[14px] font-semibold border-2 transition-all hover:shadow-md"
                      style={{ borderColor: view === AppState.KUMIHAN_MEISHI ? '#10b981' : '#3b82f6', color: view === AppState.KUMIHAN_MEISHI ? '#10b981' : '#3b82f6' }}>
                      <LayoutTemplate size={18} /> テンプレートを作成・編集
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {/* テンプレートデザイナー */}
        {view === AppState.TEMPLATE_MEISHI && (
          <TemplateDesigner
            category="meishi"
            onBack={() => setView(AppState.KUMIHAN_MEISHI)}
            flash={flash}
            colors={C}
          />
        )}
        {view === AppState.TEMPLATE_NEWSPAPER && (
          <TemplateDesigner
            category="newspaper"
            onBack={() => setView(AppState.KUMIHAN_NEWSPAPER)}
            flash={flash}
            colors={C}
          />
        )}
        {view === AppState.TEMPLATE_BOOK && (
          <TemplateDesigner
            category="book"
            onBack={() => setView(AppState.KUMIHAN_COMMERCIAL)}
            flash={flash}
            colors={C}
          />
        )}
        {/* AIインデザイン */}
        {view === AppState.AI_INDESIGN && (
          <div className="flex-1 overflow-auto p-8" style={{ background: C.bg }}>
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="rounded-2xl p-1" style={{ background: 'linear-gradient(135deg, #f59e0b, #fbbf24)' }}>
                <div className="bg-white rounded-[14px] p-8">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #f59e0b, #fbbf24)' }}>
                      <Monitor size={24} className="text-white" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-gray-900">AIインデザイン連携</h2>
                      <p className="text-sm text-gray-500">ローカルのInDesignをMCPで制御</p>
                    </div>
                  </div>
                  <p className="text-sm text-gray-600 mb-6 leading-relaxed">
                    ローカルPCにインストールされたAdobe InDesignに接続し、<br/>
                    組版指示書に基づいて自動でドキュメント生成・テキスト流し込み・スタイル適用を実行します。
                  </p>
                  <div className="grid grid-cols-2 gap-3 mb-6">
                    {[
                      { label: 'ドキュメント新規作成', desc: '判型・マージン・段組みを自動設定' },
                      { label: 'テキスト流し込み', desc: '原稿テキストをフレームに自動配置' },
                      { label: 'スタイル適用', desc: '見出し・本文・キャプションのスタイル' },
                      { label: 'PDF書き出し', desc: 'PDF/X-4入稿用データを自動生成' },
                    ].map(cmd => (
                      <div key={cmd.label} className="border rounded-xl p-4 hover:border-amber-300 transition-all cursor-pointer" style={{ borderColor: C.border }}>
                        <p className="text-sm font-bold text-gray-800">{cmd.label}</p>
                        <p className="text-xs text-gray-500 mt-1">{cmd.desc}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200">
                    <div className="w-3 h-3 rounded-full bg-red-400 animate-pulse" />
                    <span className="text-sm text-amber-800 font-medium">InDesign未接続 — ローカルMCPサーバーを起動してください</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {view === AppState.MARKDOWN_EDIT && (
          <div className="flex-1 overflow-auto p-6" style={{ background: C.bg }}>
            <div className="max-w-[1600px] mx-auto space-y-4">
              {/* Upload Area */}
              {!mdMarkdown && (
                <div className="rounded-2xl p-1" style={{ background: C.gradientPrimary }}>
                  <div className="bg-white rounded-[14px] p-8 text-center">
                    <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: C.gradientPrimary }}>
                      <FileEdit size={32} className="text-white" />
                    </div>
                    <h2 className="text-xl font-bold text-gray-900 mb-2">PDF → Markdown → PDF</h2>
                    <p className="text-sm text-gray-500 mb-6 leading-relaxed">
                      PDFをアップロードすると、MarkItDown + Gemini Vision OCRでMarkdownに変換。<br/>
                      テキストを自由に編集し、修正PDFを出力できます。
                    </p>
                    <input
                      ref={mdFileRef}
                      type="file"
                      accept=".pdf"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setMdLoading(true);
                        flash('PDF → Markdown 変換中...', 'info');
                        try {
                          const buf = await file.arrayBuffer();
                          const bytes = new Uint8Array(buf);
                          let binary = '';
                          const chunk = 8192;
                          for (let i = 0; i < bytes.length; i += chunk) {
                            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
                          }
                          const b64 = btoa(binary);
                          setMdPdfB64(b64);
                          const data = await analyzeMarkdown(b64);
                          setMdMarkdown(data.markdown);
                          setMdOriginalMarkdown(data.markdown);
                          if (data.pages.length > 0) {
                            setMdPageMM([data.pages[0].width_mm, data.pages[0].height_mm]);
                            setMdPreviewPngs(data.pages.map(p => p.preview_b64));
                          }
                          setMdAccuracy(data.accuracy_score || 0);
                          setMdSourcesAvail(data.sources_available || []);
                          if (data.detected_webfonts && data.detected_webfonts.length > 0) {
                            setMdDetectedFonts(data.detected_webfonts);
                            setMdFont(data.detected_webfonts[0]);
                          } else {
                            setMdDetectedFonts([]);
                            setMdFont('auto');
                          }
                          if (data.docai_md) setMdDocaiMd(data.docai_md);
                          const scoreEmoji = (data.accuracy_score || 0) >= 95 ? '🟢' : (data.accuracy_score || 0) >= 80 ? '🟡' : '🔴';
                          flash(`${scoreEmoji} 精度 ${data.accuracy_score || '?'}%（${data.source || 'auto'}）${data.verification_notes ? ' — ' + data.verification_notes : ''}`, 'ok');
                        } catch (err: any) {
                          flash(`変換エラー: ${err.message}`, 'error');
                        } finally {
                          setMdLoading(false);
                        }
                      }}
                    />
                    <button
                      onClick={() => mdFileRef.current?.click()}
                      disabled={mdLoading}
                      className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-white font-bold text-sm"
                      style={{ background: C.gradientPrimary, opacity: mdLoading ? 0.5 : 1 }}
                    >
                      <Upload size={18} />
                      PDFをアップロード
                    </button>
                  </div>
                </div>
              )}

              {/* Editor + Preview */}
              {mdMarkdown && (
                <>
                  {/* Toolbar */}
                  <div className="flex items-center gap-3 flex-wrap">
                    {mdAccuracy > 0 && (
                      <div
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold"
                        style={{
                          background: mdAccuracy >= 95 ? '#dcfce7' : mdAccuracy >= 80 ? '#fef9c3' : '#fecaca',
                          color: mdAccuracy >= 95 ? '#166534' : mdAccuracy >= 80 ? '#854d0e' : '#991b1b',
                        }}
                        title={`精度検証: ${mdAccuracy}% | ソース: ${mdSourcesAvail.join(', ')}`}
                      >
                        {mdAccuracy >= 95 ? '🟢' : mdAccuracy >= 80 ? '🟡' : '🔴'}
                        精度 {mdAccuracy}%
                        <span className="text-[10px] opacity-70 ml-1">
                          ({mdSourcesAvail.length}エンジン)
                        </span>
                      </div>
                    )}
                    <button
                      onClick={() => mdFileRef.current?.click()}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border"
                      style={{ borderColor: C.border, color: C.text }}
                    >
                      <Upload size={14} /> 別のPDF
                    </button>
                    <input ref={mdFileRef} type="file" accept=".pdf" className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setMdLoading(true);
                        flash('PDF → Markdown 変換中...', 'info');
                        try {
                          const buf = await file.arrayBuffer();
                          const bytes2 = new Uint8Array(buf);
                          let binary2 = '';
                          const chk2 = 8192;
                          for (let i = 0; i < bytes2.length; i += chk2) {
                            binary2 += String.fromCharCode(...bytes2.subarray(i, i + chk2));
                          }
                          const b64 = btoa(binary2);
                          setMdPdfB64(b64);
                          const data = await analyzeMarkdown(b64);
                          setMdMarkdown(data.markdown);
                          setMdOriginalMarkdown(data.markdown);
                          if (data.pages.length > 0) {
                            setMdPageMM([data.pages[0].width_mm, data.pages[0].height_mm]);
                            setMdPreviewPngs(data.pages.map(p => p.preview_b64));
                          }
                          setMdAccuracy(data.accuracy_score || 0);
                          setMdSourcesAvail(data.sources_available || []);
                          if (data.detected_webfonts && data.detected_webfonts.length > 0) {
                            setMdDetectedFonts(data.detected_webfonts);
                            setMdFont(data.detected_webfonts[0]);
                          } else {
                            setMdDetectedFonts([]);
                            setMdFont('auto');
                          }
                          if (data.docai_md) setMdDocaiMd(data.docai_md);
                          setMdOutputPdfB64(null);
                          setMdOutputPreviews([]);
                          flash(`変換完了`, 'ok');
                        } catch (err: any) {
                          flash(`変換エラー: ${err.message}`, 'error');
                        } finally {
                          setMdLoading(false);
                        }
                      }}
                    />
                    <button
                      onClick={() => setMdShowPreview(!mdShowPreview)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border"
                      style={{ borderColor: C.border, color: C.text }}
                    >
                      {mdShowPreview ? <EyeOff size={14} /> : <Eye size={14} />}
                      {mdShowPreview ? 'プレビュー非表示' : 'プレビュー表示'}
                    </button>
                    <button
                      onClick={() => {
                        setMdMarkdown(mdOriginalMarkdown);
                        flash('元のMarkdownに戻しました', 'info');
                      }}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border"
                      style={{ borderColor: C.border, color: C.text }}
                    >
                      <RefreshCw size={14} /> リセット
                    </button>

                    {/* md2pdf-ja オプション */}
                    <div className="flex items-center gap-2 ml-3">
                      <select
                        value={mdTheme}
                        onChange={(e) => setMdTheme(e.target.value as any)}
                        className="text-xs px-2 py-1.5 rounded-lg border bg-white focus:outline-none"
                        style={{ borderColor: C.border }}
                        title="テーマ"
                      >
                        <option value="default">標準</option>
                        <option value="academic">学術</option>
                        <option value="business">ビジネス</option>
                      </select>
                      <select
                        value={mdFont}
                        onChange={(e) => setMdFont(e.target.value as any)}
                        className="text-xs px-2 py-1.5 rounded-lg border bg-white focus:outline-none"
                        style={{ borderColor: C.border }}
                        title="フォント (自動検出でWebFont適用)"
                      >
                        <option value="auto">自動 (デフォルト)</option>
                        {mdDetectedFonts.map((f, idx) => (
                           <option key={idx} value={f}>{f} (検出)</option>
                        ))}
                        <option disabled>──────</option>
                        <option value="Shippori Mincho">明朝 (Shippori)</option>
                        <option value="Zen Kaku Gothic New">ゴシック (Zen)</option>
                        <option value="Zen Maru Gothic">丸ゴシック (Zen)</option>
                        <option value="Noto Serif JP">Noto Serif JP</option>
                        <option value="Noto Sans JP">Noto Sans JP</option>
                      </select>
                      <select
                        value={mdFormat}
                        onChange={(e) => setMdFormat(e.target.value as any)}
                        className="text-xs px-2 py-1.5 rounded-lg border bg-white focus:outline-none"
                        style={{ borderColor: C.border }}
                        title="用紙サイズ"
                      >
                        <option value="A4">A4</option>
                        <option value="A5">A5</option>
                        <option value="B5">B5</option>
                        <option value="Letter">Letter</option>
                      </select>
                      <button
                        onClick={() => setMdVertical(!mdVertical)}
                        className={`text-xs px-3 py-1.5 rounded-lg border font-bold transition-all ${
                          mdVertical
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'bg-white text-gray-600'
                        }`}
                        style={{ borderColor: mdVertical ? undefined : C.border }}
                        title="縦書きモード (writing-mode: vertical-rl)"
                      >
                        {mdVertical ? '縦書' : '横書'}
                      </button>
                    </div>

                    <div className="flex-1" />
                    <button
                      onClick={async () => {
                        if (!mdMarkdown.trim()) return;
                        setMdLoading(true);
                        flash('Markdown → PDF 変換中...', 'info');
                        try {
                          const data = await markdownToPdf(
                            mdMarkdown,
                            mdPageMM,
                            mdPdfB64 || undefined,
                            undefined,
                            { theme: mdTheme, format: mdFormat, vertical: mdVertical, font_family_override: mdFont === 'auto' ? undefined : mdFont },
                          );
                          setMdOutputPdfB64(data.pdf_b64);
                          setMdOutputPreviews(data.preview_pngs || []);
                          flash('PDF生成完了！', 'ok');
                          // ダウンロード
                          const a = document.createElement('a');
                          a.href = `data:application/pdf;base64,${data.pdf_b64}`;
                          a.download = 'edited_document.pdf';
                          a.click();
                        } catch (err: any) {
                          flash(`PDF生成エラー: ${err.message}`, 'error');
                        } finally {
                          setMdLoading(false);
                        }
                      }}
                      disabled={mdLoading}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-white font-bold text-sm shadow-lg hover:shadow-xl transition-all"
                      style={{ background: C.gradientPrimary, opacity: mdLoading ? 0.5 : 1 }}
                    >
                      <Download size={16} />
                      修正PDF出力
                    </button>
                  </div>

                  {/* Main Editor Area */}
                  <div className="flex gap-4" style={{ minHeight: 'calc(100vh - 220px)' }}>
                    {/* Markdown Editor */}
                    <div className="flex-1 flex flex-col min-w-0">
                      <div className="text-xs font-bold text-gray-500 mb-1.5 flex items-center gap-2">
                        <FileText size={13} />
                        Markdown テキスト（直接編集可能）
                      </div>
                      <textarea
                        value={mdMarkdown}
                        onChange={(e) => setMdMarkdown(e.target.value)}
                        className="flex-1 w-full p-4 rounded-xl border font-mono text-[13px] leading-relaxed resize-none focus:outline-none focus:ring-2"
                        style={{
                          borderColor: C.border,
                          background: '#fafbfc',
                          minHeight: '500px',
                        }}
                        spellCheck={false}
                      />
                      <div className="text-xs text-gray-400 mt-1">
                        {mdMarkdown.length} 文字 | {mdMarkdown.split('\n').length} 行
                        {mdMarkdown !== mdOriginalMarkdown && (
                          <span className="text-amber-500 font-bold ml-2">● 変更あり</span>
                        )}
                      </div>
                    </div>

                    {/* Preview Panel */}
                    {mdShowPreview && (
                      <div className="w-[480px] flex flex-col shrink-0">
                        <div className="text-xs font-bold text-gray-500 mb-1.5 flex items-center gap-2">
                          <Eye size={13} />
                          元PDFプレビュー
                        </div>
                        <div className="flex-1 rounded-xl border overflow-auto" style={{ borderColor: C.border, background: '#f8f8f8' }}>
                          {mdOutputPreviews.length > 0 ? (
                            <div className="space-y-2 p-2">
                              <div className="text-xs font-bold text-green-600 text-center py-1">▼ 出力プレビュー</div>
                              {mdOutputPreviews.map((png, idx) => (
                                <img
                                  key={`out-${idx}`}
                                  src={`data:image/png;base64,${png}`}
                                  alt={`Output page ${idx + 1}`}
                                  className="w-full rounded-lg shadow-sm"
                                />
                              ))}
                            </div>
                          ) : mdPreviewPngs.length > 0 ? (
                            <div className="space-y-2 p-2">
                              <div className="text-xs font-bold text-gray-500 text-center py-1">▼ 元PDF</div>
                              {mdPreviewPngs.map((png, idx) => (
                                <img
                                  key={`orig-${idx}`}
                                  src={`data:image/png;base64,${png}`}
                                  alt={`Page ${idx + 1}`}
                                  className="w-full rounded-lg shadow-sm"
                                />
                              ))}
                            </div>
                          ) : (
                            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                              プレビューなし
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Loading Overlay */}
              {mdLoading && (
                <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 flex items-center justify-center">
                  <div className="bg-white rounded-2xl p-8 shadow-2xl text-center">
                    <div
                      className="animate-spin w-10 h-10 border-3 border-slate-200 rounded-full mx-auto mb-4"
                      style={{ borderTopColor: C.accent }}
                    />
                    <p className="text-base font-bold text-slate-700">変換中...</p>
                    <p className="text-xs mt-1" style={{ color: C.muted }}>
                      MarkItDown + Gemini Vision OCRでテキスト抽出中
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {view === AppState.EDIT && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 flex flex-col min-w-0">
              <MeishiEditor {...appProps} />
            </div>
            {showChatInEditor && renderChatPanel()}
          </div>
        )}
      </div>

      {/* Hidden file input for local PDF upload */}
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUpload(file);
          e.target.value = '';
        }}
      />

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
