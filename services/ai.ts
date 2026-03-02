import { Span } from '../types';

const GOOGLE_AI_KEY = import.meta.env.VITE_GOOGLE_AI_KEY as string;

const geminiUrl = (model = 'gemini-2.0-flash') =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_AI_KEY}`;

export interface CorrectedSpan {
  id: string;
  text: string;
  category: string;
}

/**
 * 2-pass AI pipeline:
 *   Pass 1 — Gemini Vision reads the card image + span positions → corrected text
 *   Pass 2 — Gemini verifies & fixes the result against the image
 */
export async function correctOcrWithAI(
  imageBase64: string,       // raw base64 (no data:... prefix)
  mergedSpans: Span[],
): Promise<CorrectedSpan[]> {
  if (!GOOGLE_AI_KEY) {
    console.warn('VITE_GOOGLE_AI_KEY not set — skipping AI correction');
    return mergedSpans.map(s => ({ id: s.id, text: s.text, category: 'other' }));
  }

  // ── Pass 1: Extract ──
  const spanList = mergedSpans.map((s, i) => (
    `${i + 1}. id="${s.id}" 位置(左${s.x_pct.toFixed(1)}%, 上${s.y_pct.toFixed(1)}%) OCR: "${s.text}"`
  )).join('\n');

  const extractPrompt = `あなたは名刺OCR補正AIです。
名刺の画像と、サーバーOCRが検出した各テキスト領域の座標＋文字列を提供します。
OCRのテキストは断片化・誤認識されています。画像を直接見て、各領域の正しいテキストを読み取ってください。

## OCR検出結果（座標は正確、テキストは不正確）:
${spanList}

## 指示:
1. 画像上の各座標位置のテキストを正確に読み取る
2. 以下のカテゴリに分類: company, company_en, department, title, name, address, phone, fax, mobile, email, url, slogan, other
3. OCR結果にない視覚要素（ロゴテキスト等）は無視
4. テスト用の赤い数字（123等）は除外
5. 1文字だけの無意味なフィールドは、近い位置のフィールドに統合

## 出力（JSONのみ、他のテキスト不要）:
[{"id":"元のspan ID","text":"正確なテキスト","category":"カテゴリ名"}]

複数のOCR領域が1つのテキストに統合すべき場合、最初のIDを使い、他は除外してください。`;

  const pass1 = await callGemini(imageBase64, extractPrompt);

  let fields: CorrectedSpan[];
  try {
    const clean = pass1.replace(/```json|```/g, '').trim();
    fields = JSON.parse(clean);
  } catch {
    console.error('AI Pass 1 parse failed:', pass1);
    return mergedSpans.map(s => ({ id: s.id, text: s.text, category: 'other' }));
  }

  // ── Pass 2: Verify & correct ──
  const verifyPrompt = `名刺のOCR結果を検証してください。画像と以下の抽出結果を比較し、間違いがあれば修正してください。

## 現在の抽出結果:
${JSON.stringify(fields, null, 2)}

## 検証項目:
- 会社名の正確な表記（株式会社の位置含む）
- 氏名の漢字が正しいか
- 電話番号・FAXの桁数と形式
- メールアドレスのスペル
- URLのドメインスペル
- 住所の番地・ビル名

## 出力（修正済みJSONのみ）:
[{"id":"span ID","text":"検証済みテキスト","category":"カテゴリ名"}]`;

  const pass2 = await callGemini(imageBase64, verifyPrompt);

  try {
    const clean = pass2.replace(/```json|```/g, '').trim();
    const verified: CorrectedSpan[] = JSON.parse(clean);
    return verified;
  } catch {
    console.warn('AI Pass 2 parse failed, using Pass 1 result');
    return fields;
  }
}

async function callGemini(imageBase64: string, prompt: string): Promise<string> {
  const res = await fetch(geminiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: imageBase64,
            },
          },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4000,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
