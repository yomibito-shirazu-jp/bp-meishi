import React from 'react';
import { AppState } from '../types';
import { C } from '../constants';
import {
  LayoutDashboard, Inbox, Wand2, List, Clock, FileAudio,
  PenTool, ScanText, FileEdit, FileDiff, ShieldCheck, BookType,
  LayoutTemplate, Settings, ChevronLeft,
} from 'lucide-react';

interface SidebarProps {
  view: AppState;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  inboxCount: number;
  showChatInEditor: boolean;
  onNavigate: (state: AppState) => void;
  onResetAll: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  view, sidebarCollapsed, setSidebarCollapsed,
  inboxCount, showChatInEditor,
  onNavigate, onResetAll,
}) => {
  const sections = [
    {
      title: '名刺データ管理',
      items: [
        { icon: LayoutDashboard, label: '一覧', badge: 0, state: AppState.DASHBOARD },
        { icon: Inbox, label: '受信', badge: inboxCount, state: AppState.INBOX },
        { icon: Wand2, label: 'AI作成', badge: 0, state: AppState.AI_CHAT },
      ],
    },
    {
      title: 'AI文字起こし',
      items: [
        { icon: List, label: '一覧', badge: 0, state: AppState.TRANSCRIBE_LIST },
        { icon: Clock, label: '履歴', badge: 0, state: AppState.TRANSCRIBE_HISTORY },
        { icon: FileAudio, label: 'AI作成', badge: 0, state: AppState.TRANSCRIBE_AI },
      ],
    },
    {
      title: '印刷ツール',
      items: [
        { icon: PenTool, label: '文章作成', badge: 0, state: AppState.TOOL_WRITING },
        { icon: ScanText, label: 'OCR・文字起こし', badge: 0, state: AppState.TOOL_OCR },
        { icon: FileEdit, label: 'PDF加工・編集', badge: 0, state: AppState.TOOL_PDF_EDIT },
        { icon: FileDiff, label: 'PDF比較', badge: 0, state: AppState.TOOL_PDF_COMPARE },
        { icon: ShieldCheck, label: '校閲・校正', badge: 0, state: AppState.TOOL_PROOFREAD },
        { icon: BookType, label: '組版指示書', badge: 0, state: AppState.TOOL_TYPESET_SPEC },
      ],
    },
    {
      title: '自動組版',
      items: [
        { icon: LayoutTemplate, label: 'レイアウト検出', badge: 0, state: AppState.TOOL_DETECT_LAYOUT },
        { icon: ShieldCheck, label: '原稿検証', badge: 0, state: AppState.TOOL_VALIDATE_MS },
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
          印
        </div>
        {!sidebarCollapsed && (
          <span className="text-sm font-bold tracking-tight leading-tight" style={{ color: C.text }}>
            印刷ツールボックス
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
                      if (item.state === AppState.DASHBOARD) { onResetAll(); }
                      else onNavigate(item.state);
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
          onClick={() => onNavigate(AppState.SETTINGS)}
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

export default Sidebar;
