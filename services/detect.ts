/**
 * detect.ts — レイアウト検出サービス
 * 
 * 優先順位:
 *   1. Edge Function (bp-typesetting Supabase) — サーバーサイドでGemini呼び出し + DB保存
 *   2. フロントエンド直接 Gemini API — Edge Function が利用不可の場合のフォールバック
 */

import { DetectionSessionResult } from '../types';
import { getConfig } from './config';

const TYPESETTING_URL = 'https://avakiygdyafqjrhlvbjg.supabase.co';
const TYPESETTING_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2YWtpeWdkeWFmcWpyaGx2YmpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5ODAzOTIsImV4cCI6MjA4OTU1NjM5Mn0.6X_9qlsrQSXx9eSKZQ3k0bqT2CM083L_NDsiSLaolOI';

/**
 * PDFファイルをページ画像に変換
 * 既存の backend /analyze を利用してページ画像を抽出
 */
export async function extractPagesFromPdf(
  file: File,
  apiUrl: string,
): Promise<Array<{ page_number: number; png_b64: string; page_mm: [number, number] }>> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${apiUrl}/analyze`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`PDF分析エラー: ${res.status}`);
  }

  const data = await res.json();
  return data.pages.map((page: any, idx: number) => ({
    page_number: idx + 1,
    png_b64: page.original_png_b64,
    page_mm: page.page_mm,
  }));
}

// ── Gemini responseSchema 定義（PGが固定する「事実＝構造」） ──

const COMPONENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    page_geometry: {
      type: "OBJECT",
      description: "ページ全体のマージンと基本グリッド設定（単位はmm）",
      properties: {
        margins: {
          type: "OBJECT",
          properties: {
            top_mm: { type: "NUMBER", description: "天マージン(mm)" },
            bottom_mm: { type: "NUMBER", description: "地マージン(mm)" },
            inside_mm: { type: "NUMBER", description: "のどマージン(mm)" },
            outside_mm: { type: "NUMBER", description: "小口マージン(mm)" },
          },
          required: ["top_mm", "bottom_mm", "inside_mm", "outside_mm"],
        },
        base_column_count: { type: "INTEGER", description: "基本の段数" },
        base_writing_mode: { type: "STRING", description: "ベース組方向: vertical-rl または horizontal-tb" },
      },
      required: ["margins", "base_column_count", "base_writing_mode"],
    },
    design_tokens: {
      type: "OBJECT",
      description: "ページで使われている共通のデザイントークン",
      properties: {
        primary_color: { type: "STRING", description: "メインカラー #RRGGBB形式" },
        secondary_color: { type: "STRING", description: "サブカラー #RRGGBB形式。なければ空文字" },
        base_font_family: { type: "STRING", description: "本文のフォントファミリ名" },
        heading_font_family: { type: "STRING", description: "見出しのフォントファミリ名" },
        base_font_size_q: { type: "NUMBER", description: "本文の級数(Q)" },
        base_line_height_q: { type: "NUMBER", description: "本文の行送り(Q)" },
      },
      required: ["primary_color", "base_font_family", "base_font_size_q", "base_line_height_q"],
    },
    components: {
      type: "ARRAY",
      description: "ページ内で検出された意味的コンポーネント",
      items: {
        type: "OBJECT",
        properties: {
          component_code: { type: "STRING", description: "snake_caseのコンポーネント識別子。例: main_article, qa_box" },
          component_name: { type: "STRING", description: "日本語の表示名" },
          semantic_tag: { type: "STRING", description: "HTMLタグ: article, aside, section, figure 等" },
          writing_mode: { type: "STRING", description: "組方向: vertical-rl または horizontal-tb" },
          font_size_q: { type: "NUMBER", description: "本文の級数(Q)" },
          line_height_q: { type: "NUMBER", description: "行送り(Q)" },
          has_border: { type: "BOOLEAN", description: "枠線があるか" },
          border_color: { type: "STRING", description: "枠線の色 #RRGGBB" },
          has_background: { type: "BOOLEAN", description: "背景色ベタ塗りがあるか" },
          background_color: { type: "STRING", description: "背景色 #RRGGBB" },
          heading_font_size_q: { type: "NUMBER", description: "見出しの級数(Q)" },
          column_count: { type: "INTEGER", description: "段数" },
          estimated_area_pct: { type: "NUMBER", description: "ページ面積に対する占有率(0-100)" },
        },
        required: ["component_code", "component_name", "semantic_tag", "writing_mode", "font_size_q", "line_height_q", "has_border", "has_background", "column_count", "estimated_area_pct"],
      },
    },
  },
  required: ["page_geometry", "design_tokens", "components"],
};

const DETECT_PROMPT = `あなたはプロのDTPオペレーター兼自動組版エンジニアです。
提供されたページ画像を解析し、レイアウトの「プリセット」として再利用できるよう、
指定されたJSONスキーマに従ってパラメータ値のみを正確に抽出してください。

【解析ルール】
1. ページ内の視覚的な「意味のある塊（コンポーネント）」を全て検出する
2. メイン記事、囲み記事（Q&A, レシピ, コラム等）、写真キャプション等を分類する
3. 縦組み(vertical-rl)と横組み(horizontal-tb)の混在を正確に検出する
4. 色はすべて #RRGGBB のHEX値で出力する
5. フォントサイズは級数(Q)で出力する（1Q = 0.25mm, 概算でOK）
6. コンポーネントが見つからない場合でも最低1つ(main_article)は返す
7. デザインの意図を推測し、再現性の高いパラメータ値を抽出する

【重要】
- 構造やキー名は変更せず、値のみを埋めてください
- 推測が難しい場合は安全なデフォルト値（黒=#333333, 13Q等）を使用してください`;

/**
 * フロントエンドからGemini APIを直接呼び出して検出（フォールバック用）
 */
async function detectViaDirectGemini(
  imageBase64: string,
  mimeType: string,
): Promise<any> {
  const apiKey = getConfig('VITE_GOOGLE_AI_KEY');
  if (!apiKey) throw new Error('VITE_GOOGLE_AI_KEY が未設定です。「設定」から入力してください。');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: imageBase64 } },
        { text: DETECT_PROMPT },
      ],
    }],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema: COMPONENT_SCHEMA,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(text);
}

/**
 * 検出結果をDetectionSessionResult形式に変換（フロントエンド直接の場合）
 */
function wrapAsDetectionResult(
  detected: any,
  pageNumber: number,
  customerName: string,
  projectName: string,
): DetectionSessionResult {
  const components = (detected.components || []).map((comp: any) => ({
    code: comp.component_code,
    name: comp.component_name,
    id: `local_${comp.component_code}_${Date.now()}`,
  }));

  return {
    success: true,
    session_id: `local_${Date.now()}`,
    globals_id: `local_globals_${Date.now()}`,
    page_number: pageNumber,
    detection: {
      components_count: components.length,
      components,
      page_geometry: detected.page_geometry,
      design_tokens: detected.design_tokens,
    },
    validation: {
      errors_count: 0,
      errors: [],
      status: 'approved',
    },
  };
}

/**
 * 1ページの画像からレイアウト検出
 * Edge Function → フォールバック: フロントエンドGemini API直接呼び出し
 */
export async function detectPageLayout(params: {
  image_base64: string;
  mime_type?: string;
  customer_name: string;
  project_name: string;
  page_number: number;
  session_id?: string;
  trim_width_mm?: number;
  trim_height_mm?: number;
}): Promise<DetectionSessionResult> {
  // Try Edge Function first
  try {
    const url = `${TYPESETTING_URL}/functions/v1/detect-layout`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TYPESETTING_ANON_KEY}`,
      },
      body: JSON.stringify({
        image_base64: params.image_base64,
        mime_type: params.mime_type || 'image/png',
        customer_name: params.customer_name,
        project_name: params.project_name,
        page_number: params.page_number,
        session_id: params.session_id,
        trim_width_mm: params.trim_width_mm,
        trim_height_mm: params.trim_height_mm,
      }),
    });

    if (res.ok) {
      const result = await res.json();
      if (result.success) return result;
    }
    // Edge Function failed, fall through to direct Gemini
    console.warn('[detect] Edge Function failed, falling back to direct Gemini API');
  } catch (e) {
    console.warn('[detect] Edge Function unreachable, falling back to direct Gemini API:', e);
  }

  // Fallback: Direct Gemini API from frontend
  const detected = await detectViaDirectGemini(
    params.image_base64,
    params.mime_type || 'image/png',
  );

  return wrapAsDetectionResult(
    detected,
    params.page_number,
    params.customer_name,
    params.project_name,
  );
}

/**
 * 複数ページを順次検出
 */
export async function detectAllPages(params: {
  pages: Array<{ page_number: number; png_b64: string; page_mm: [number, number] }>;
  customer_name: string;
  project_name: string;
  onProgress?: (current: number, total: number, result: DetectionSessionResult) => void;
}): Promise<DetectionSessionResult[]> {
  const results: DetectionSessionResult[] = [];
  let sessionId: string | undefined;

  for (let i = 0; i < params.pages.length; i++) {
    const page = params.pages[i];
    const result = await detectPageLayout({
      image_base64: page.png_b64,
      customer_name: params.customer_name,
      project_name: params.project_name,
      page_number: page.page_number,
      session_id: sessionId,
      trim_width_mm: page.page_mm[0],
      trim_height_mm: page.page_mm[1],
    });

    if (!sessionId && result.session_id) {
      sessionId = result.session_id;
    }

    results.push(result);
    params.onProgress?.(i + 1, params.pages.length, result);
  }

  return results;
}
