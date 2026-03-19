
import React, { useState, useEffect, useRef } from 'react';
import {
  Clock,
  FileText,
  Mail,
  Send,
  Cpu,
  Inbox,
  Sparkles,
  Archive,
  Reply,
  ChevronRight,
  MessageSquare,
  LayoutGrid,
  ShieldCheck,
  ArrowRight,
  Volume2,
  Loader2,
  Check,
  X,
  ExternalLink,
  MapPin,
  Search,
  History
} from 'lucide-react';
import { AppTab, ChatEntry, BriefingItem, TriageEmail } from './types';
import { getExecutiveAction, generateBriefing, speakContent, decodeAndPlayAudio, executeApprovedTool } from './services/geminiService';
import { setReauthRequired } from './services/mcpService';
import { supabase } from './services/supabaseClient';
import { Session } from '@supabase/supabase-js';

const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('briefing');
  const [isProcessing, setIsProcessing] = useState(false);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');

  const [timeline, setTimeline] = useState<(BriefingItem | TriageEmail)[]>([]);
  const [isSpeaking, setIsSpeaking] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loadingStep, setLoadingStep] = useState<string>('初期化中');
  const [hasAuthError, setHasAuthError] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ label: string, status: 'wait' | 'load' | 'done' }[]>([
    { label: '基盤接続', status: 'wait' },
    { label: '予定同期', status: 'wait' },
    { label: '優先判定', status: 'wait' },
    { label: '報告構成', status: 'wait' }
  ]);

  useEffect(() => {
    const runAuth = async (session: Session | null) => {
      setSession(session);
      setIsAuthenticated(!!session);
      // refresh_token は exchange-google-code（独自OAuth）でのみ保存。Supabase標準Google OAuth では provider_refresh_token が渡らないため save-google-token は呼ばない。
      setAuthReady(true);

      // 追加: provider_refresh_token があれば保存する
      if (session?.provider_refresh_token) {
        console.log("🔄 Provider refresh token found, saving to DB...");
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/exchange-google-code`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
          },
          body: JSON.stringify({
            refresh_token: session.provider_refresh_token
          })
        });

        if (response.ok) {
          console.log("🎉 Success! Provider refresh token saved.");
          setHasAuthError(false);
        } else {
          const err = await response.json().catch(() => ({}));
          console.error("❌ Failed to save provider refresh token:", response.status, err);
          // ここではエラー状態を true にしない。なぜなら、元々 code がない場合のフォールバックだから。
        }
      }

      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        if (!session) {
          console.warn('[OAuth] URL に ?code= ありだがセッションなし。再ログイン後に同じ URL で再試行するか、再連携をやり直してください。');
          setHasAuthError(true);
          return;
        }
        console.info('[OAuth] exchange-google-code を呼びます');
        const redirectUri = window.location.origin;
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/exchange-google-code`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirect_uri: redirectUri }),
        });
        window.history.replaceState({}, '', window.location.pathname);
        if (res.ok) {
          console.info('[OAuth] exchange-google-code 成功');
          setHasAuthError(false);
        } else {
          const err = await res.json().catch(() => ({}));
          console.error('[OAuth] exchange-google-code 失敗:', res.status, err?.code ?? err?.error);
          setHasAuthError(true);
        }
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => runAuth(session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => runAuth(session));

    const onReauthRequired = () => setHasAuthError(true);
    window.addEventListener('gws:reauth-required', onReauthRequired);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('gws:reauth-required', onReauthRequired);
    };
  }, []);

  useEffect(() => {
    setReauthRequired(hasAuthError);
  }, [hasAuthError]);

  useEffect(() => {
    if (authReady && isAuthenticated && session && !hasAuthError) {
      loadBriefing();
    }
  }, [authReady, isAuthenticated, session, hasAuthError]);

  const updateProgress = (index: number, status: 'wait' | 'load' | 'done') => {
    setSyncProgress(prev => {
      const next = [...prev];
      next[index] = { ...next[index], status };
      return next;
    });
  };

  const loadBriefing = async () => {
    setIsProcessing(true);
    setTimeline([]);

    // 手順 0: 基盤
    updateProgress(0, 'load');
    await new Promise(r => setTimeout(r, 600));
    updateProgress(0, 'done');

    // 手順 1: 予定表
    updateProgress(1, 'load');
    setLoadingStep('Google カレンダーを確認しています…');

    try {
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

      const dataPromise = generateBriefing(`日付: ${dateStr}, 時刻: ${timeStr}`);

      await new Promise(r => setTimeout(r, 1500));
      updateProgress(1, 'done');

      // 手順 2: 判定
      updateProgress(2, 'load');
      setLoadingStep('メールをチェックしています…');
      await new Promise(r => setTimeout(r, 2000));
      updateProgress(2, 'done');

      // 手順 3: 作成
      updateProgress(3, 'load');
      setLoadingStep('報告書を作成しています…');
      await new Promise(r => setTimeout(r, 2000));

      const data = await dataPromise;
      setLoadingStep('準備が整いました。');
      await new Promise(r => setTimeout(r, 1000));
      updateProgress(3, 'done');

      setTimeline(data);
    } catch (e) {
      console.error(e);
      if (e instanceof Error && e.message.includes("REAUTHENTICATION_REQUIRED")) {
        setHasAuthError(true);
      }
    } finally {
      setIsProcessing(false);
      setSyncProgress(p => p.map(s => ({ ...s, status: 'wait' })));
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setHistory([]);
    setChatLog([]);
    setTimeline([]);
    setHasAuthError(false);
  };

  const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly';

  const login = async () => {
    setIsProcessing(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          scopes: SCOPES,
          queryParams: { access_type: 'offline', prompt: 'consent' },
          redirectTo: window.location.origin
        }
      });
      if (error) throw error;
    } catch (e) {
      console.error(e);
      setIsProcessing(false);
    }
  };

  const loginWithCustomOAuth = () => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      console.error('[OAuth] VITE_GOOGLE_CLIENT_ID が未設定です。独自OAuthで ?code= を得るには .env に設定しビルドし直してください。Supabaseログインにフォールバックします。');
      login();
      return;
    }
    const redirectUri = window.location.origin;
    const url = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
    window.location.href = url;
  };


  const handleSpeak = async (item: BriefingItem | TriageEmail) => {
    if (isSpeaking) return;
    setIsSpeaking(item.id);
    try {
      const text = 'type' in item
        ? `${item.time}の${item.title}について要約します。${item.summary}`
        : `${item.from}様からのメール、件名${item.subject}について。${item.summary}`;
      const audioData = await speakContent(text);
      await decodeAndPlayAudio(audioData);
    } finally {
      setIsSpeaking(null);
    }
  };

  const handleCommand = async (text: string) => {
    if (!text.trim()) return;
    setChatLog(prev => [...prev, { role: 'user', text }]);
    setInput('');
    setActiveTab('chat');
    setIsProcessing(true);
    try {
      const res = await getExecutiveAction(text, 'gemini-2.5-flash', history);
      const newAssistantEntry: ChatEntry = {
        role: 'assistant',
        text: res.text,
        status: res.pendingToolCall ? 'pending_approval' : 'completed',
        pendingToolCall: res.pendingToolCall ? { name: res.pendingToolCall.name!, args: res.pendingToolCall.args } : undefined,
        grounding: res.grounding
      };
      setChatLog(prev => [...prev, newAssistantEntry]);
      setHistory(prev => [...prev, { role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: res.text }] }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('REAUTHENTICATION_REQUIRED')) {
        setHasAuthError(true);
        setChatLog(prev => [...prev, { role: 'assistant', text: 'Google ワークスペースとの再連携が必要です。上の「再連携する」ボタンを押してください。', status: 'completed' }]);
      } else {
        setChatLog(prev => [...prev, { role: 'assistant', text: `エラー: ${msg}`, status: 'completed' }]);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApprove = async (entryIndex: number) => {
    const entry = chatLog[entryIndex];
    if (!entry.pendingToolCall) return;
    setIsProcessing(true);
    try {
      const res = await executeApprovedTool(entry.pendingToolCall, history);
      setChatLog(prev => {
        const next = [...prev];
        next[entryIndex] = { ...next[entryIndex], status: 'completed' };
        next.push({
          role: 'assistant',
          text: res.text,
          status: res.pendingToolCall ? 'pending_approval' : 'completed',
          pendingToolCall: res.pendingToolCall ? { name: res.pendingToolCall.name!, args: res.pendingToolCall.args } : undefined,
          grounding: res.grounding
        });
        return next;
      });
      setHistory(prev => [...prev, { role: 'model', parts: [{ text: res.text }] }]);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="h-screen max-w-md mx-auto bg-slate-50 text-slate-900 flex flex-col items-center justify-center p-8 relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[120%] h-[50%] bg-indigo-500/5 blur-[120px] rounded-full"></div>
        <div className="relative z-10 flex flex-col items-center w-full animate-in fade-in zoom-in duration-700">
          <div className="w-20 h-20 bg-white border border-slate-200 rounded-3xl flex items-center justify-center shadow-sm mb-16">
            <Cpu size={32} className="text-slate-400" />
          </div>

          <button
            onClick={login}
            disabled={isProcessing}
            className="w-full bg-white border border-slate-200 text-slate-700 py-4 px-6 rounded-lg font-medium text-[15px] flex items-center justify-center gap-4 active:scale-95 transition-all shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {isProcessing ? (
              <span className="animate-pulse flex items-center gap-2">
                <Loader2 size={18} className="animate-spin" /> 接続中
              </span>
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8c-.2 1.1-.8 2-1.8 2.6v2.2h2.9c1.7-1.6 2.7-4 2.7-6.4z" />
                  <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.6-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3C2.4 15.5 5.5 18 9 18z" />
                  <path fill="#FBBC05" d="M3.9 10.7c-.2-.6-.2-1.2-.2-1.7s.1-1.1.2-1.7V4.9H.9C.3 6.1 0 7.5 0 9s.3 2.9.9 4.1l3-2.4z" />
                  <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.5C13.4.9 11.4 0 9 0 5.5 0 2.4 2.5.9 5.6l3 2.3c.7-2.3 2.7-4.3 5.1-4.3z" />
                </svg>
                Google ワークスペース 連携開始
              </>
            )}
          </button>

          <p className="mt-8 text-[11px] text-slate-400 font-medium tracking-tight">Google ワークスペースとの同期を安全に実行します</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-white text-slate-900 shadow-2xl overflow-hidden font-sans relative border-x border-slate-100">
      <header className="px-8 pt-14 pb-6 flex items-center justify-between z-10 border-b border-slate-200 bg-white">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600"></div>
            <h1 className="text-base font-bold tracking-widest text-slate-900">本日の状況</h1>
          </div>
          {session?.user?.email && (
            <p className="text-[10px] text-slate-500 font-bold mt-1 tracking-tight truncate max-w-[150px]">
              お名前: {session.user.email}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <p className="text-2xl font-bold font-mono tracking-tighter text-slate-800">
            {new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </p>
          <button onClick={logout} className="text-[11px] font-black tracking-widest text-red-600 underline decoration-slate-200 underline-offset-4">
            連携解除
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative bg-slate-50/30">
        {activeTab === 'briefing' && (
          <div className="h-full flex flex-col pt-6">
            <div className="flex-1 overflow-x-auto scroll-smooth snap-x snap-mandatory no-scrollbar flex items-start px-8 gap-8">
              {timeline.length > 0 ? (
                timeline.map((item) => (
                  <div key={item.id} className="min-w-full snap-center py-4">
                    <div className="bg-white border border-slate-200 rounded-[3.5rem] p-10 h-[620px] shadow-xl flex flex-col relative overflow-hidden group">
                      {'type' in item && item.type === 'schedule' ? (
                        <>
                          <div className="mb-10">
                            <span className="text-indigo-600 font-mono text-xl font-black">{item.time}</span>
                            <h3 className="text-3xl font-black mt-3 leading-tight tracking-tight text-slate-900">{item.title}</h3>
                          </div>
                          <div className="flex-1 space-y-8 overflow-y-auto no-scrollbar">
                            <p className="text-slate-600 text-base leading-relaxed font-medium">{item.summary}</p>
                            <div className="space-y-4">
                              <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400">背景事項</h4>
                              {item.context?.emails.map((e, idx) => (
                                <div key={idx} className="bg-slate-50 p-6 rounded-[2rem] border border-slate-100 space-y-2">
                                  <div className="flex justify-between items-center text-indigo-600">
                                    <span className="text-[12px] font-black">{e.from}</span>
                                    <Mail size={14} />
                                  </div>
                                  <p className="text-sm font-bold text-slate-800">{e.subject}</p>
                                  <p className="text-[12px] text-slate-500 leading-snug line-clamp-2">{e.snippet}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div className="mt-8 flex gap-4">
                            <button onClick={() => handleCommand(`${item.title}について詳しく教えてください`)} className="flex-1 py-5 bg-slate-950 text-white rounded-2xl font-black text-xs uppercase tracking-[0.2em] shadow-lg active:scale-95 transition-all">詳細を聞く</button>
                            <button onClick={() => handleSpeak(item)} disabled={isSpeaking !== null} className={`px-6 rounded-2xl border border-slate-200 flex items-center justify-center transition-all ${isSpeaking === item.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-400 hover:text-slate-900'}`}>
                              {isSpeaking === item.id ? <Loader2 size={18} className="animate-spin" /> : <Volume2 size={18} />}
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="mb-10">
                            <span className="text-emerald-600 text-[11px] font-black uppercase tracking-[0.2em] bg-emerald-50 px-4 py-2 rounded-full border border-emerald-100">緊急信書</span>
                            <h3 className="text-2xl font-black mt-8 leading-tight tracking-tight text-slate-900">{(item as TriageEmail).subject}</h3>
                            <p className="text-indigo-600 text-sm font-bold mt-3">発信者: {(item as TriageEmail).from}</p>
                          </div>
                          <div className="flex-1 overflow-y-auto no-scrollbar">
                            <div className="bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 h-full">
                              <p className="text-slate-600 text-base leading-relaxed font-medium">{(item as TriageEmail).summary}</p>
                              <div className="mt-6 p-4 bg-indigo-50 border border-indigo-100 rounded-2xl">
                                <p className="text-[11px] font-black text-indigo-600 uppercase tracking-widest">重要判断根拠</p>
                                <p className="text-[13px] text-indigo-800 mt-2 font-medium">{(item as TriageEmail).reason}</p>
                              </div>
                            </div>
                          </div>
                          <div className="mt-8 flex gap-3">
                            <button onClick={() => handleCommand(`${(item as TriageEmail).from}への返信案を作成せよ`)} className="flex-1 py-5 bg-indigo-600 text-white rounded-2xl font-black text-xs uppercase tracking-[0.2em] shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2">案文作成</button>
                            <button onClick={() => handleSpeak(item)} disabled={isSpeaking !== null} className={`px-6 rounded-2xl border border-slate-200 flex items-center justify-center transition-all ${isSpeaking === item.id ? 'bg-indigo-600 text-white' : 'bg-white text-slate-400'}`}>
                              {isSpeaking === item.id ? <Loader2 size={18} className="animate-spin" /> : <Volume2 size={18} />}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))
              ) : isProcessing ? (
                <div className="min-w-full flex flex-col items-center justify-center p-12 text-center animate-in fade-in duration-1000">
                  <div className="relative mb-16">
                    <div className="w-32 h-32 bg-indigo-500/5 rounded-full blur-3xl animate-pulse absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"></div>
                    <div className="w-28 h-28 border border-slate-200 rounded-full flex items-center justify-center relative bg-white shadow-xl overflow-hidden">
                      <div className="w-12 h-12 rounded-full border border-indigo-200 flex items-center justify-center animate-[spin_10s_linear_infinite]">
                        <div className="w-2 h-2 bg-indigo-600 rounded-full shadow-[0_0_15px_rgba(79,70,229,0.8)]"></div>
                      </div>
                      <div className="absolute top-0 w-full h-1/2 bg-gradient-to-b from-indigo-500/5 to-transparent animate-[scan_2s_ease-in-out_infinite]"></div>
                    </div>
                  </div>
                  <div className="space-y-8 w-full max-w-[300px]">
                    <div className="space-y-2">
                      <p className="text-[11px] font-black text-indigo-600 uppercase tracking-[0.4em] animate-pulse">専属秘書</p>
                      <h2 className="text-xl font-bold tracking-tight text-slate-900">「本日の状況を確認しております」</h2>
                    </div>
                    <div className="h-12 flex items-center justify-center">
                      <p className="text-xs text-slate-500 font-bold leading-relaxed">{loadingStep}</p>
                    </div>
                    <div className="flex justify-center gap-3 pt-6">
                      {syncProgress.map((step, i) => (
                        <div key={i} className={`h-1 w-10 rounded-full transition-all duration-700 ${step.status === 'done' ? 'bg-indigo-600' : step.status === 'load' ? 'bg-slate-300' : 'bg-slate-100'}`}></div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : !isProcessing ? (
                <div className="min-w-full flex flex-col items-center justify-center p-12 text-center space-y-8">
                  <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center border border-slate-100 shadow-inner">
                    {hasAuthError ? <ShieldCheck size={40} className="text-red-500" strokeWidth={1} /> : <History size={40} className="text-slate-300" strokeWidth={1} />}
                  </div>
                  <div className="px-6">
                    <p className={`text-[15px] mt-4 leading-relaxed font-bold text-left border-l-4 pl-4 py-8 ${hasAuthError ? 'bg-red-50 border-red-500 text-slate-800' : 'text-slate-500 border-slate-200'}`}>
                      {hasAuthError
                        ? "Google ワークスペースとの連携が必要です。ボタンを押して認証設定を更新してください。"
                        : "現在、表示できる予定がございません。最新情報に更新してください。"
                      }
                    </p>
                  </div>
                  <div className="flex flex-col gap-4 w-full px-6">
                    {hasAuthError ? (
                      <>
                        <button onClick={loginWithCustomOAuth} className="w-full py-5 bg-red-600 text-white rounded-3xl text-sm font-black tracking-widest shadow-lg active:scale-95 transition-all">
                          Google ワークスペースと再連携する
                        </button>
                        <p className="text-[10px] text-slate-400 text-center">
                          独自OAuth: {import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ? '設定済み' : '未設定（ボタン押下でSupabaseログインになります）'}
                        </p>
                      </>
                    ) : (
                      <button onClick={loadBriefing} className="w-full py-5 bg-indigo-600 text-white rounded-3xl text-sm font-black tracking-widest shadow-lg active:scale-95 transition-all">
                        最新情報を再取得する
                      </button>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="p-8 h-full flex flex-col overflow-y-auto no-scrollbar pb-44 space-y-8">
            {hasAuthError && (
              <div className="mb-6 p-6 bg-red-50 border border-red-200 rounded-2xl flex flex-col gap-4">
                <p className="text-sm font-bold text-red-800">Google ワークスペースとの再連携が必要です</p>
                <button onClick={loginWithCustomOAuth} className="w-full py-4 bg-red-600 text-white rounded-xl text-sm font-black tracking-widest shadow-lg active:scale-95 transition-all">
                  再連携する
                </button>
                <p className="text-[10px] text-slate-500 text-center">
                  独自OAuth: {import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ? '設定済み' : '未設定'}
                </p>
              </div>
            )}
            {chatLog.map((log, i) => (
              <div key={i} className={`flex flex-col ${log.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[90%] p-7 rounded-[2.5rem] text-[15px] leading-relaxed shadow-sm ${log.role === 'user' ? 'bg-slate-900 text-white rounded-tr-none' : 'bg-white text-slate-800 border border-slate-100 rounded-tl-none'}`}>
                  {log.text}
                  {log.grounding?.searchEntryPoint && (
                    <div className="mt-6 pt-6 border-t border-slate-100 flex flex-wrap gap-2">
                      <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest flex items-center gap-1 w-full mb-1"><Search size={12} /> 出典・根拠資料</span>
                      {log.grounding.groundingChunks?.map((chunk: any, idx: number) => (
                        chunk.web && (
                          <a key={idx} href={chunk.web.uri} target="_blank" className="bg-slate-50 px-4 py-2 rounded-full text-[11px] text-indigo-600 hover:bg-indigo-50 transition-colors border border-slate-100 inline-flex items-center gap-2 shadow-sm">
                            <ExternalLink size={11} /><span className="truncate max-w-[120px]">{chunk.web.title}</span>
                          </a>
                        )
                      ))}
                    </div>
                  )}
                  {log.status === 'pending_approval' && log.pendingToolCall && (
                    <div className="mt-8 bg-slate-50 rounded-[2rem] p-8 border border-slate-100 space-y-6 shadow-inner">
                      <div className="flex items-center gap-4">
                        <div className="p-3 bg-white rounded-2xl shadow-sm border border-slate-100 text-indigo-600">{log.pendingToolCall.name === 'send_email' ? <Mail size={20} /> : <Clock size={20} />}</div>
                        <div>
                          <p className="text-[11px] font-black uppercase text-slate-400 tracking-[0.2em]">実行承認待ち</p>
                          <p className="text-sm font-black text-slate-900">{log.pendingToolCall.name === 'send_email' ? '電子信書の送付' : '予定の更新'}</p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <button onClick={() => handleApprove(i)} className="flex-1 py-4 bg-slate-950 text-white rounded-2xl font-black text-xs uppercase shadow-xl hover:bg-black transition-colors">承認して実行</button>
                        <button className="px-6 py-4 bg-white text-slate-400 border border-slate-200 rounded-2xl font-black text-xs"><X size={16} /></button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isProcessing && (
              <div className="flex items-center gap-4 animate-pulse px-4 pt-4">
                <div className="w-2 h-2 bg-indigo-600 rounded-full"></div>
                <span className="text-[11px] font-black text-slate-400 tracking-[0.2em] uppercase">情報を解析中…</span>
              </div>
            )}
          </div>
        )}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 p-8 safe-bottom bg-gradient-to-t from-white via-white to-transparent z-50">
        <div className="max-w-md mx-auto space-y-6">
          <div className="bg-white border border-slate-200 rounded-full flex items-center p-2 shadow-2xl focus-within:ring-2 ring-indigo-500/20 transition-all">
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCommand(input)} placeholder="御指示を入力願います…" className="flex-1 bg-transparent text-[15px] px-8 py-5 outline-none text-slate-900 font-bold placeholder-slate-300" />
            <button onClick={() => handleCommand(input)} className="w-14 h-14 bg-slate-950 text-white rounded-full flex items-center justify-center active:scale-90 transition-all shadow-xl"><Send size={24} /></button>
          </div>
          <div className="bg-slate-50 border border-slate-100 rounded-full p-2 flex items-center justify-around shadow-inner">
            <button onClick={() => setActiveTab('briefing')} className={`flex flex-col items-center gap-1.5 py-2 px-6 rounded-full transition-all ${activeTab === 'briefing' ? 'bg-indigo-50 shadow-sm text-indigo-600 border border-indigo-100' : 'text-slate-400'}`}>
              <LayoutGrid size={22} />
              <span className="text-[10px] font-bold tracking-widest">今日の報告</span>
            </button>
            <button onClick={() => setActiveTab('chat')} className={`flex flex-col items-center gap-1.5 py-2 px-6 rounded-full transition-all ${activeTab === 'chat' ? 'bg-indigo-50 shadow-sm text-indigo-600 border border-indigo-100' : 'text-slate-400'}`}>
              <MessageSquare size={22} />
              <span className="text-[10px] font-bold tracking-widest">秘書と相談</span>
            </button>
          </div>
        </div>
      </nav>
    </div>
  );
};

export default App;
