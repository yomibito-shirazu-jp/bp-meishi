import React from 'react';
import { AppState } from '../types';
import { C } from '../constants';
import {
  ArrowLeft, CreditCard, Download, Save,
  MessageSquare, Wand2, HardDrive, Sparkles,
  Settings, FileAudio, LayoutTemplate, ShieldCheck,
} from 'lucide-react';

interface HeaderProps {
  view: AppState;
  editCount: number;
  editingProjectId: string | null;
  showChatInEditor: boolean;
  pdfB64: string | null;
  onResetAll: () => void;
  onSave: () => void;
  onRebuild: () => void;
  onToggleChat: () => void;
  onAICreate: () => void;
  onGoogleDrive: () => void;
}

const Header: React.FC<HeaderProps> = ({
  view, editCount, editingProjectId, showChatInEditor, pdfB64,
  onResetAll, onSave, onRebuild, onToggleChat, onAICreate, onGoogleDrive,
}) => (
  <div className="h-14 bg-white border-b px-6 flex items-center justify-between shrink-0" style={{ borderColor: C.border }}>
    <div className="flex items-center gap-4">
      {view === AppState.EDIT && (
        <button
          onClick={onResetAll}
          className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 text-sm font-medium transition-colors"
        >
          <ArrowLeft size={16} /> 一覧へ戻る
        </button>
      )}
      {view === AppState.DASHBOARD && <h2 className="text-base font-bold text-slate-800">名刺データ一覧</h2>}
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
      {view === AppState.TOOL_WRITING && <h2 className="text-base font-bold text-slate-800">文章作成</h2>}
      {view === AppState.TOOL_OCR && <h2 className="text-base font-bold text-slate-800">OCR・文字起こし</h2>}
      {view === AppState.TOOL_PDF_EDIT && <h2 className="text-base font-bold text-slate-800">PDF加工・修正・編集</h2>}
      {view === AppState.TOOL_PDF_COMPARE && <h2 className="text-base font-bold text-slate-800">PDF比較</h2>}
      {view === AppState.TOOL_PROOFREAD && <h2 className="text-base font-bold text-slate-800">校閲・校正・ファクトチェック</h2>}
      {view === AppState.TOOL_TYPESET_SPEC && <h2 className="text-base font-bold text-slate-800">組版指示書</h2>}
      {view === AppState.TOOL_DETECT_LAYOUT && (
        <div className="flex items-center gap-2">
          <LayoutTemplate size={16} style={{ color: C.accent }} />
          <h2 className="text-base font-bold text-slate-800">レイアウト検出・プリセット化</h2>
        </div>
      )}
      {view === AppState.TOOL_VALIDATE_MS && (
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: C.accent }} />
          <h2 className="text-base font-bold text-slate-800">原稿検証・第一レポート</h2>
        </div>
      )}
      {view === AppState.EDIT && (
        <div className="flex items-center gap-2">
          <CreditCard size={16} className="text-slate-400" />
          <span className="text-sm font-medium text-slate-700">
            {editingProjectId ? 'データ編集' : '新規データ'}
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
            onClick={onAICreate}
            className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm hover:opacity-90 border"
            style={{ background: 'linear-gradient(135deg, #0d9488, #06b6d4)', color: 'white' }}
          >
            <Wand2 size={16} /> AIで作成
          </button>
          <button
            onClick={onGoogleDrive}
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
            onClick={onToggleChat}
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
            onClick={onSave}
            className="flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm font-medium px-3 py-2 rounded-lg hover:bg-slate-50 border transition-colors"
            style={{ borderColor: C.border }}
          >
            <Save size={15} /> 保存
          </button>
          <button
            onClick={onRebuild}
            disabled={!pdfB64 || editCount === 0}
            className={`text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all shadow-sm
              ${pdfB64 && editCount > 0 ? 'hover:opacity-90' : 'opacity-40 cursor-not-allowed'}`}
            style={{ background: pdfB64 && editCount > 0 ? C.accent : '#94a3b8' }}
            title={!pdfB64 ? '元PDFがありません' : editCount === 0 ? '変更がありません' : '再構築してPDFをダウンロード'}
          >
            <Download size={15} /> 再構築 & PDF出力
          </button>
        </>
      )}
    </div>
  </div>
);

export default Header;
