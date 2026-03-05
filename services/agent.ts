import { Span } from '../types';

const GOOGLE_AI_KEY = import.meta.env.VITE_GOOGLE_AI_KEY as string;

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  actions?: AgentAction[];
}

export interface AgentAction {
  type: 'update_span' | 'add_span' | 'delete_span' | 'update_style' | 'move_span';
  spanId?: string;
  updates?: Partial<Span>;
  description: string;
}

export interface AgentResponse {
  message: string;
  actions: AgentAction[];
}

/**
 * Sends a user instruction to Gemini and gets structured actions to modify the card.
 */
export async function runAgentInstruction(
  instruction: string,
  currentSpans: Span[],
  pageMM: [number, number],
  imageBase64?: string | null,
  conversationHistory: AgentMessage[] = [],
): Promise<AgentResponse> {
  if (!GOOGLE_AI_KEY) {
    return {
      message: 'API キーが設定されていません。.env.local に VITE_GOOGLE_AI_KEY を設定してください。',
      actions: [],
    };
  }

  const spanList = currentSpans.map((s, i) => (
    `${i + 1}. id="${s.id}" text="${s.text}" font="${s.font_class}" size=${s.size_pt}pt pos=(${s.x_pct.toFixed(1)}%, ${s.y_pct.toFixed(1)}%) size=(${s.w_pct.toFixed(1)}%×${s.h_pct.toFixed(1)}%)`
  )).join('\n');

  const historyContext = conversationHistory.slice(-6).map(m =>
    `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`
  ).join('\n');

  const systemPrompt = `あなたは名刺編集AIエージェントです。ユーザーの自然言語指示に基づいて名刺のテキストやレイアウトを操作します。

## 現在の名刺情報
- サイズ: ${pageMM[0]}mm × ${pageMM[1]}mm
- フィールド一覧:
${spanList || '(フィールドなし)'}

## 利用可能なフォント
- gothic: ゴシック (Noto Sans JP)
- mincho: 明朝 (Noto Serif JP)
- light: ライト
- gothic_bold: ゴシック太

## 会話履歴
${historyContext || '(なし)'}

## ルール
1. ユーザーの指示を理解し、具体的なアクションに変換する
2. テキスト変更、フォント変更、サイズ変更、位置移動が可能
3. 複数の変更を一度に実行可能
4. 実行するアクションを日本語で分かりやすく説明する
5. 不明な点があれば質問する
6. アクションがない場合（質問への回答など）はactionsを空配列にする

## 出力形式（JSONのみ、他のテキスト不要）
{
  "message": "ユーザーへの応答メッセージ（実行結果の説明や質問）",
  "actions": [
    {
      "type": "update_span",
      "spanId": "対象のspan ID",
      "updates": {
        "text": "新しいテキスト（変更する場合）",
        "font_class": "新しいフォント（変更する場合）",
        "size_pt": 12,
        "x_pct": 10.0,
        "y_pct": 20.0
      },
      "description": "変更内容の日本語説明"
    }
  ]
}`;

  const parts: any[] = [];

  // Include image if available
  if (imageBase64) {
    const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: rawBase64,
      },
    });
  }

  parts.push({ text: `${systemPrompt}\n\n## ユーザーの指示\n${instruction}` });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_AI_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4000,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  try {
    const clean = responseText.replace(/```json|```/g, '').trim();
    const parsed: AgentResponse = JSON.parse(clean);
    return parsed;
  } catch {
    // If parsing fails, return the raw text as message
    return {
      message: responseText || '応答を解析できませんでした。',
      actions: [],
    };
  }
}
