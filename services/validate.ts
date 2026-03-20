/**
 * validate.ts — 原稿検証 & PDCAフィードバック APIクライアント
 * 
 * validate-manuscript: 原稿チャンク + レイアウト制約 → RAG検証 → 第一レポート
 * feedback-loop: ユーザー判断 → 差分分析 → 新ルール自動生成 → RAG蓄積
 */

import {
  ManuscriptChunk,
  ValidationReportResponse,
  FeedbackInput,
  FeedbackResponse,
  ConsensusReport,
  ChunkDetail,
  ValidationError,
} from '../types';
import { getConfig } from './config';

const TYPESETTING_URL = 'https://avakiygdyafqjrhlvbjg.supabase.co';
const TYPESETTING_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2YWtpeWdkeWFmcWpyaGx2YmpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5ODAzOTIsImV4cCI6MjA4OTU1NjM5Mn0.6X_9qlsrQSXx9eSKZQ3k0bqT2CM083L_NDsiSLaolOI';

// ── Gemini直接呼び出し用のスキーマ（フォールバック） ──
const VALIDATION_SCHEMA = {
  type: "ARRAY",
  description: "チャンクごとの検証結果",
  items: {
    type: "OBJECT",
    properties: {
      chunk_id: { type: "STRING" },
      status: { type: "STRING", description: "OK または NG" },
      errors: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            error_type: { type: "STRING" },
            original_text: { type: "STRING" },
            suggested_text: { type: "STRING" },
            reason_ref: { type: "STRING" },
            severity: { type: "STRING" },
          },
          required: ["error_type", "original_text", "suggested_text", "reason_ref", "severity"],
        },
      },
    },
    required: ["chunk_id", "status", "errors"],
  },
};

/**
 * テキストからコンポーネント単位にチャンク分解する
 * detect-layoutの結果（コンポーネントリスト）に基づいて分解
 */
export function chunkManuscript(
  fullText: string,
  componentTypes: string[],
): ManuscriptChunk[] {
  // テキストを段落で分割
  const paragraphs = fullText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  if (paragraphs.length === 0) {
    return [{ chunk_id: 'chunk_0', role: 'body_text', text: fullText }];
  }

  const chunks: ManuscriptChunk[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    let role = 'body_text';

    // ヒューリスティクスでロール推定
    if (para.match(/^[QＱ][.．\s:：]/i) || para.match(/^[AＡ][.．\s:：]/i)) {
      role = 'qa_box';
    } else if (para.match(/^(#{1,3}\s|■|●|◆|【|《)/)) {
      role = 'heading';
    } else if (para.match(/^[\d０-９]+[.．)）\s]/)) {
      role = 'ordered_list';
    } else if (para.match(/^[・●○▶]/)) {
      role = 'bullet_list';
    } else if (para.match(/レシピ|材料|分量|作り方|手順/)) {
      role = 'recipe_box';
    } else if (para.match(/^(注|※|\*|出典|参考)/)) {
      role = 'footnote';
    } else if (para.length < 50) {
      role = 'caption';
    }

    chunks.push({
      chunk_id: `chunk_${i}`,
      role,
      text: para,
    });
  }

  return chunks;
}

/**
 * Edge Function: validate-manuscript を呼び出す
 * フォールバック: フロントエンドからGemini直接呼び出し
 */
export async function validateManuscript(params: {
  customer_name: string;
  publication_name?: string;
  session_id?: string;
  globals_id?: string;
  chunks: ManuscriptChunk[];
  layout_constraints?: any;
}): Promise<ValidationReportResponse> {
  // Try Edge Function first
  try {
    const url = `${TYPESETTING_URL}/functions/v1/validate-manuscript`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TYPESETTING_ANON_KEY}`,
      },
      body: JSON.stringify({
        customer_name: params.customer_name,
        publication_name: params.publication_name || '',
        session_id: params.session_id,
        globals_id: params.globals_id,
        chunks: params.chunks,
        layout_constraints: params.layout_constraints,
      }),
    });

    if (res.ok) {
      const result = await res.json();
      if (result.success) return result;
    }
    console.warn('[validate] Edge Function failed, falling back to direct Gemini');
  } catch (e) {
    console.warn('[validate] Edge Function unreachable:', e);
  }

  // Fallback: Direct Gemini API
  return await validateViaDirectGemini(params);
}

/**
 * フロントエンドから直接Geminiで検証（フォールバック）
 */
async function validateViaDirectGemini(params: {
  customer_name: string;
  chunks: ManuscriptChunk[];
  layout_constraints?: any;
}): Promise<ValidationReportResponse> {
  const apiKey = getConfig('VITE_GOOGLE_AI_KEY');
  if (!apiKey) throw new Error('VITE_GOOGLE_AI_KEY が未設定です');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;

  const chunksText = params.chunks.map(c =>
    `--- chunk_id: ${c.chunk_id} | role: ${c.role} | text_length: ${c.text.length}文字 ---\n${c.text}`
  ).join('\n\n');

  const prompt = `あなたはプロのDTP品質管理エージェントです。
提供された「原稿チャンク」が、「レイアウトの制約」に適合しているか検証してください。

【検証の厳密さ】
- 表記揺れ（全角/半角、送り仮名の不統一）は必ず検出
- 禁則処理違反があれば指摘
- NGの場合は具体的な修正テキストを suggested_text に提示
- エラーがない場合は status: 'OK', errors: [] とする

【1. レイアウト制約】
${JSON.stringify(params.layout_constraints || {}, null, 2)}

【2. 検証対象の原稿チャンク】
${chunksText}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: VALIDATION_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const validationItems = JSON.parse(text) as Array<{
    chunk_id: string;
    status: 'OK' | 'NG';
    errors: ValidationError[];
  }>;

  // Build consensus report locally
  let overflowErrors = 0;
  let ruleErrors = 0;
  const chunkDetails: ChunkDetail[] = params.chunks.map(chunk => {
    const validation = validationItems.find(v => v.chunk_id === chunk.chunk_id);
    const errors = validation?.errors || [];

    for (const err of errors) {
      if (err.error_type === '文字あふれ' || err.error_type === '構造・あふれ警告') {
        overflowErrors++;
      } else {
        ruleErrors++;
      }
    }

    return {
      chunk_id: chunk.chunk_id,
      component_type: chunk.role,
      status: validation?.status || 'OK',
      current_text: chunk.text,
      text_length: chunk.text.length,
      layout_constraint: null,
      validation_results: errors,
    };
  });

  const totalErrors = overflowErrors + ruleErrors;
  const consensus: ConsensusReport = {
    status: totalErrors === 0 ? 'ready' : 'needs_revision',
    total_chunks: params.chunks.length,
    error_count_overflow: overflowErrors,
    error_count_rule: ruleErrors,
    error_count_total: totalErrors,
    chunk_details: chunkDetails,
  };

  return {
    success: true,
    report_id: `local_${Date.now()}`,
    consensus,
    rag_rules_used: 0,
    rag_rules: [],
  };
}

/**
 * PDCAフィードバックを送信
 */
export async function submitFeedback(params: {
  report_id: string;
  feedbacks: FeedbackInput[];
}): Promise<FeedbackResponse> {
  // Try Edge Function first
  try {
    const url = `${TYPESETTING_URL}/functions/v1/feedback-loop`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TYPESETTING_ANON_KEY}`,
      },
      body: JSON.stringify({
        report_id: params.report_id,
        feedbacks: params.feedbacks,
      }),
    });

    if (res.ok) {
      const result = await res.json();
      if (result.success) return result;
    }
    console.warn('[feedback] Edge Function failed');
  } catch (e) {
    console.warn('[feedback] Edge Function unreachable:', e);
  }

  // Fallback: local mock response
  return {
    success: true,
    report_id: params.report_id,
    feedbacks_processed: params.feedbacks.length,
    rules_created: 0,
    pdca_cycle: {
      plan: '第一レポートでAIが検証',
      do: `ユーザーが${params.feedbacks.length}件の判断を実行`,
      check: `${params.feedbacks.filter(f => f.action_type === 'manual_override' || f.action_type === 'reject').length}件の差分を検出`,
      action: 'Edge Function未接続のためローカル保存',
    },
    results: params.feedbacks.map(f => ({
      chunk_id: f.chunk_id,
      action_type: f.action_type,
      rule_generated: false,
      generated_rule_text: null,
    })),
  };
}
