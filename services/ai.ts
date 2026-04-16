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
 * ドキュメント種別を自動判定してOCR結果を補正・分類する
 * 1パスでGemini Visionに投げて高速化
 */
export async function correctOcrWithAI(
  imageBase64: string,       // raw base64 (no data:... prefix)
  mergedSpans: Span[],
): Promise<CorrectedSpan[]> {
  if (!getConfig('VITE_GOOGLE_AI_KEY')) {
    console.warn('VITE_GOOGLE_AI_KEY not set — skipping AI correction');
    return mergedSpans.map(s => ({ id: s.id, text: s.text, category: 'other' }));
  }

  const spanList = mergedSpans.map((s, i) => (
    `${i + 1}. id="${s.id}" 位置(左${s.x_pct.toFixed(1)}%, 上${s.y_pct.toFixed(1)}%) サイズ:${s.size_pt}pt OCR: "${s.text}"`
  )).join('\n');

  const prompt = `あなたは高精度ドキュメントOCR検証AIです。
提供された画像とサーバーOCRの検出結果を照合し、テキスト修正とフィールド分類を行います。

## まずドキュメント種別を判定してください:
- 名刺 (business_card)
- 請求書・見積書・納品書 (invoice)
- 契約書・申込書 (contract)
- 書籍・冊子ページ (book)
- チラシ・ポスター (flyer)
- その他 (other)

## OCR検出結果 (${mergedSpans.length}フィールド):
${spanList}

## 指示:
1. OCR結果が正しい場合はそのまま維持（不要な変更をしない）
2. 画像と照合して明らかに間違っている文字だけを修正する
3. 数字・金額・日付は画像と完全一致させる
4. 人名の漢字は特に慎重に — OCRが正しく読めている漢字を別の漢字に変えないこと
5. ドキュメント種別に応じたカテゴリで分類する:

### 名刺の場合:
company, company_en, department, title, name, name_en, address, postal, phone, fax, mobile, email, url, other

### 請求書・見積書の場合:
doc_title, doc_number, date, company_from, company_to, address, phone, fax, item_name, quantity, unit_price, amount, subtotal, tax, total, payment_terms, bank_info, note, other

### 書籍の場合:
chapter, heading, body, page_number, header, footer, caption, note, other

### その他:
title, heading, body, label, value, date, number, address, name, note, other

6. テスト用の赤い数字（123等）は除外
7. OCR結果にない視覚要素（ロゴ等）は無視

## 出力（JSONのみ、他のテキスト不要）:
[{"id":"元のspan ID","text":"修正後テキスト","category":"カテゴリ名"}]

複数のOCR領域が1つのテキストに統合すべき場合、最初のIDを使い、他は除外してください。`;

  const result = await callGemini(imageBase64, prompt);

  try {
    const clean = result.replace(/```json|```/g, '').trim();
    const fields: CorrectedSpan[] = JSON.parse(clean);
    return fields;
  } catch {
    console.error('AI parse failed:', result);
    return mergedSpans.map(s => ({ id: s.id, text: s.text, category: 'other' }));
  }
}

async function resizeImageForGemini(base64: string, maxDimension = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      // Already small enough
      if (width <= maxDimension && height <= maxDimension) {
        resolve(base64);
        return;
      }
      // Scale down proportionally
      const scale = maxDimension / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(base64); return; }
      ctx.drawImage(img, 0, 0, width, height);
      // Use JPEG for smaller payload
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const resized = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      console.log(`[resizeImageForGemini] ${img.naturalWidth}x${img.naturalHeight} → ${width}x${height} (${(resized.length / 1024).toFixed(0)}KB)`);
      resolve(resized);
    };
    img.onerror = () => {
      console.warn('[resizeImageForGemini] Failed to load image, using original');
      resolve(base64);
    };
    img.src = `data:image/png;base64,${base64}`;
  });
}

async function callGemini(imageBase64: string, prompt: string): Promise<string> {
  // Resize image to avoid Gemini API 400 errors on large images
  const resizedBase64 = await resizeImageForGemini(imageBase64);
  // Detect MIME type based on whether we resized (JPEG) or kept original (PNG)
  const mimeType = resizedBase64 !== imageBase64 ? 'image/jpeg' : 'image/png';

  let retries = 3;
  let lastError: Error | null = null;

  while (retries > 0) {
    try {
      const res = await fetch(geminiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: resizedBase64,
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
    } catch (e: any) {
      lastError = e;
      retries--;
      if (retries > 0) {
        console.warn(`AI API call failed, retrying (${retries} retries left):`, e);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw lastError || new Error('Gemini API call failed after retries');
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
