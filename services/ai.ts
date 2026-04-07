import { Span } from '../types';

import { getConfig } from './config';
import { analyzePDFWithDocumentAI, extractBusinessCardInfo, DocumentAIResult } from './documentai';

const geminiUrl = (model = 'gemini-2.0-flash') =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getConfig('VITE_GOOGLE_AI_KEY')}`;

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
  if (!getConfig('VITE_GOOGLE_AI_KEY')) {
    console.warn('VITE_GOOGLE_AI_KEY not set — skipping AI correction');
    return mergedSpans.map(s => ({ id: s.id, text: s.text, category: 'other' }));
  }

  // ── Pass 1: Extract ──
  const spanList = mergedSpans.map((s, i) => (
    `${i + 1}. id="${s.id}" 位置(左${s.x_pct.toFixed(1)}%, 上${s.y_pct.toFixed(1)}%) OCR: "${s.text}"`
  )).join('\n');

  const extractPrompt = `あなたは名刺OCR検証AIです。
名刺の画像と、サーバーOCRが検出した各テキスト領域を提供します。
OCR結果は概ね正確ですが、CIDフォントの影響で一部に文字化けや文字欠けがあります。

## OCR検出結果:
${spanList}

## 重要な指示:
1. OCR結果が正しい場合はそのまま維持すること（不要な変更をしない）
2. 画像と照合して明らかに間違っている文字だけを修正する
3. **人名の漢字は特に慎重に** — OCRが正しく読めている漢字を別の漢字に変えないこと
4. 電話番号・FAX・メール・URLは画像と完全一致させる
5. 以下のカテゴリに分類: company, company_en, department, title, name, address, phone, fax, mobile, email, url, other
6. テスト用の赤い数字（123等）は除外
7. OCR結果にない視覚要素（ロゴ等）は無視

## 出力（JSONのみ、他のテキスト不要）:
[{"id":"元のspan ID","text":"テキスト","category":"カテゴリ名"}]

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
  const verifyPrompt = `名刺画像と以下の抽出結果を照合してください。
**画像に写っている文字と一致しない箇所だけ**を修正してください。一致している箇所は絶対に変えないこと。

## 現在の抽出結果:
${JSON.stringify(fields, null, 2)}

## 検証ルール:
- 画像の文字と完全一致しているフィールドはそのまま維持（変更禁止）
- 人名: 画像の漢字を正確に読む。推測で別の漢字に置き換えない
- 電話番号・FAX: 桁数と形式を画像と一致させる
- メール・URL: スペルを画像と一致させる
- 住所: 番地・ビル名を画像と一致させる

## 出力（JSONのみ）:
[{"id":"span ID","text":"テキスト","category":"カテゴリ名"}]`;

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

/**
 * Document AIでPDFから名刺情報を抽出
 */
export async function extractBusinessCardFromPDF(
  pdfBase64: string,
  processorId?: string
): Promise<{
  cardInfo: Record<string, string>;
  confidence: number;
  blocks: any[];
  fullText: string;
}> {
  if (!getConfig('VITE_GOOGLE_PROJECT_ID')) {
    throw new Error('VITE_GOOGLE_PROJECT_ID not set — Document AI requires project ID');
  }

  try {
    const documentAIResult: DocumentAIResult = await analyzePDFWithDocumentAI(pdfBase64, processorId);
    return extractBusinessCardInfo(documentAIResult);
  } catch (error) {
    console.error('Document AI business card extraction failed:', error);
    throw error;
  }
}

/**
 * ハイブリッド名刺処理：画像OCR + PDF Document AI
 */
export async function processBusinessCardHybrid(
  imageBase64?: string,
  pdfBase64?: string,
  mergedSpans?: Span[]
): Promise<CorrectedSpan[]> {
  // PDFが提供されている場合はDocument AIを優先
  if (pdfBase64) {
    try {
      const documentAIResult = await extractBusinessCardFromPDF(pdfBase64);
      return convertDocumentAIToSpans(documentAIResult);
    } catch (error) {
      console.warn('Document AI failed, falling back to image OCR:', error);
    }
  }

  // 画像OCR処理（既存のロジック）
  if (imageBase64 && mergedSpans) {
    return await correctOcrWithAI(imageBase64, mergedSpans);
  }

  throw new Error('Either PDF or image with OCR results must be provided');
}

/**
 * Document AI結果をCorrectedSpan形式に変換
 */
function convertDocumentAIToSpans(documentAIResult: {
  cardInfo: Record<string, string>;
  confidence: number;
  blocks: any[];
  fullText: string;
}): CorrectedSpan[] {
  const spans: CorrectedSpan[] = [];
  
  // カード情報からスパンを生成
  Object.entries(documentAIResult.cardInfo).forEach(([key, value], index) => {
    spans.push({
      id: `documentai_${key}`,
      text: value,
      category: key,
    });
  });

  // ブロック情報から追加のテキストを抽出
  documentAIResult.blocks.forEach((block, index) => {
    if (block.type === 'text' && block.confidence > 0.7) {
      // 既存のカード情報に含まれていないテキストを追加
      const isDuplicate = spans.some(span => span.text === block.text);
      if (!isDuplicate) {
        spans.push({
          id: `documentai_block_${index}`,
          text: block.text,
          category: 'other',
        });
      }
    }
  });

  return spans;
}
