import React from 'react';
import { 
  Upload, Search, HardDrive, Building2, Inbox, RefreshCw, 
  FileEdit, Share2, Download, Trash2, FileText 
} from 'lucide-react';
import { CardProject, AppState } from '../types';
import { pickPdfFromDrive } from '../services/gdrive';

interface Props {
  projects: CardProject[];
  groupedProjects: [string, CardProject[]][];
  filteredProjects: CardProject[];
  inboxProjects: CardProject[];
  loading: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  fileRef: React.RefObject<HTMLInputElement>;
  handleUpload: (file: File) => void;
  flash: (msg: string, type: 'ok'|'error'|'info') => void;
  openProject: (p: CardProject) => void;
  handleDelete: (id: string) => void;
  colors: Record<string, string>;
  view: AppState;
}

export const isUnprocessed = (p: CardProject): boolean => {
  if (!p.original_spans || !p.spans || p.original_spans.length === 0) return true;
  return p.spans.every((s, i) => p.original_spans && p.original_spans[i] && s.text === p.original_spans[i].text);
};

const Dashboard: React.FC<Props> = ({
  projects,
  groupedProjects,
  filteredProjects,
  inboxProjects,
  loading,
  searchQuery,
  setSearchQuery,
  fileRef,
  handleUpload,
  flash,
  openProject,
  handleDelete,
  colors: C,
  view
}) => {

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
        <div className="flex items-center gap-1 shrink-0 transition-opacity">
          {/* 再度検証する */}
          <button
            className="p-1.5 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors flex items-center justify-center"
            title="再度検証する"
            onClick={e => { e.stopPropagation(); flash('再度検証を実行しました', 'info'); }}
          >
            <RefreshCw size={16} />
          </button>

          {/* 編集 */}
          <button
            className="px-3 py-1.5 text-white rounded-lg text-xs font-medium transition-colors hover:opacity-90 flex items-center gap-1 mx-1 shadow-sm"
            style={{ background: C.accent }}
            title="編集"
          >
            <FileEdit size={14} /> 編集
          </button>

          {/* 共有 */}
          <button
            className="p-1.5 text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors flex items-center justify-center"
            title="共有"
            onClick={e => { e.stopPropagation(); flash('共有リンクを生成しました', 'info'); }}
          >
            <Share2 size={16} />
          </button>

          {/* ダウンロード */}
          <button
            className="p-1.5 text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg transition-colors flex items-center justify-center"
            title="ダウンロード"
            onClick={e => {
              e.stopPropagation();
              const b64 = p.rebuilt_pdf_b64 || p.original_pdf_b64;
              if (b64) {
                const a = document.createElement('a');
                a.href = `data:application/pdf;base64,${b64}`;
                a.download = `${p.name || '名刺'}.pdf`;
                a.click();
              } else {
                flash('ダウンロード可能なPDFがありません', 'error');
              }
            }}
          >
            <Download size={16} />
          </button>

          {/* 削除 */}
          <button
            className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center"
            title="削除"
            onClick={e => { e.stopPropagation(); handleDelete(p.id); }}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  if (view === AppState.INBOX) {
    return (
      <div className="flex-1 overflow-auto" style={{ background: C.bg }}>
        <div className="max-w-6xl mx-auto p-8">
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
  }

  // Dashboard view
  return (
    <div className="flex-1 overflow-auto" style={{ background: C.bg }}>
      <div className="max-w-6xl mx-auto p-8">
        {/* Header and Upload actions */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-slate-800">ダッシュボード（一覧）</h2>
          <div className="flex gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              className="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all hover:opacity-90 text-white shadow-sm"
              style={{ background: 'linear-gradient(135deg, #10b981, #34d399)' }}
            >
              <Upload size={16} /> ローカルから入稿
            </button>
            <button
              onClick={async () => {
                try {
                  const file = await pickPdfFromDrive();
                  if (file) handleUpload(file);
                } catch (err: any) {
                  flash(err.message || 'Google Drive接続エラー', 'error');
                }
              }}
              className="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all hover:opacity-90 text-white shadow-sm"
              style={{ background: C.gradientPrimary }}
            >
              <HardDrive size={16} /> Driveから入稿
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div className="mb-6">
          <div className="relative max-w-lg">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: C.muted }} />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="案件名・顧客名で検索..."
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

        {/* Empty state — URL入稿 */}
        {projects.length === 0 && !loading && (
          <div className="space-y-4">
            <div className="rounded-2xl p-1 animate-fadeIn" style={{ background: C.gradientPrimary }}>
              <div className="bg-white rounded-[14px] p-12">
                <div className="max-w-lg mx-auto text-center">
                  <div
                    className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg"
                    style={{ background: C.gradientPrimary }}
                  >
                    <Upload size={32} className="text-white" />
                  </div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-2">PDFを入稿</h3>
                  <p className="text-[15px] text-gray-500 leading-relaxed mb-8">
                    ローカルPC または Google Drive からPDFを選択してください<br />
                    AI が自動で構造解析・テキスト抽出を行います
                  </p>

                  <div className="flex items-center justify-center gap-3 mb-8">
                    {[
                      { icon: '⚡', label: 'AI 構造解析' },
                      { icon: '🔤', label: 'OCR 自動補正' },
                      { icon: '📋', label: '組版指示書' },
                    ].map(f => (
                      <div
                        key={f.label}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium"
                        style={{ background: C.surface, color: C.textSec }}
                      >
                        <span>{f.icon}</span> {f.label}
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-center gap-4 flex-wrap">
                    <button
                      onClick={() => fileRef.current?.click()}
                      className="px-8 py-3.5 rounded-xl text-[14px] font-bold flex items-center gap-2 transition-all hover:opacity-90 text-white shadow-lg hover:shadow-xl hover:scale-[1.02]"
                      style={{ background: 'linear-gradient(135deg, #10b981, #34d399)' }}
                    >
                      <Upload size={18} /> ローカルPCから入稿
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const file = await pickPdfFromDrive();
                          if (file) handleUpload(file);
                        } catch (err: any) {
                          flash(err.message || 'Google Drive接続エラー', 'error');
                        }
                      }}
                      className="px-8 py-3.5 rounded-xl text-[14px] font-bold flex items-center gap-2 transition-all hover:opacity-90 text-white shadow-lg hover:shadow-xl hover:scale-[1.02]"
                      style={{ background: C.gradientPrimary }}
                    >
                      <HardDrive size={18} /> Google Driveから入稿
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-4">PDFファイルをこの画面にドラッグ＆ドロップすることもできます</p>
                </div>
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
};

export default Dashboard;
