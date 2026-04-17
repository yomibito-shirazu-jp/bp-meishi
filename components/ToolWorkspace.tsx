import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { HardDrive, FileText, Sparkles } from 'lucide-react';
import { pickPdfFromDrive } from '../services/gdrive';
import { getConfig } from '../services/config';

interface Props {
  toolId: string;
  flash: (msg: string, type: 'ok' | 'error' | 'info') => void;
  colors: Record<string, string>;
}

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

const ToolWorkspace: React.FC<Props> = ({ toolId, flash, colors: C }) => {
  const [toolInput, setToolInput] = useState('');
  const [toolOutput, setToolOutput] = useState('');
  const [toolLoading, setToolLoading] = useState(false);
  const [toolFile, setToolFile] = useState<File | null>(null);
  const [toolFile2, setToolFile2] = useState<File | null>(null);

  const def = TOOL_DEFS[toolId];

  const handleToolSubmit = async () => {
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
              onClick={handleToolSubmit}
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

export default ToolWorkspace;
