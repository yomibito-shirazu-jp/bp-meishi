// @ts-nocheck
import React from 'react';
import { Bot, Send, User, Loader2, Play } from 'lucide-react';

export interface ChatPanelProps {
  [key: string]: any;
}

const ChatPanel: React.FC<ChatPanelProps> = (props) => {
  const {
    isStandalone = false, C, chatLoading, chatMessages, chatInput, setChatInput, handleChatSubmit, chatInputRef
  } = props;

  return (
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
};

export default ChatPanel;
