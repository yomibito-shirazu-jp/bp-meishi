import { getConfig } from './config';

export interface DocumentAIPage {
  pageNumber: number;
  width: number;
  height: number;
  blocks: DocumentAIBlock[];
}

export interface DocumentAIBlock {
  id: string;
  text: string;
  type: 'text' | 'table' | 'image' | 'form';
  confidence: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  properties?: {
    fontSize?: number;
    fontFamily?: string;
    isBold?: boolean;
    isItalic?: boolean;
  };
}

export interface DocumentAIResult {
  pages: DocumentAIPage[];
  fullText: string;
  metadata: {
    totalPages: number;
    processingTime: number;
    confidence: number;
  };
}

/**
 * Google Cloud Document AI でPDFを解析
 */
export async function analyzePDFWithDocumentAI(
  pdfBase64: string,
  processorId?: string
): Promise<DocumentAIResult> {
  const apiKey = getConfig('VITE_GOOGLE_AI_KEY');
  const projectId = getConfig('VITE_GOOGLE_PROJECT_ID');
  const location = getConfig('VITE_DOCUMENT_AI_LOCATION', 'us');
  
  if (!apiKey || !projectId) {
    throw new Error('Document AI configuration missing: VITE_GOOGLE_AI_KEY and VITE_GOOGLE_PROJECT_ID required');
  }

  const defaultProcessorId = `${projectId}/locations/${location}/processors/business-card-processor`;
  const processor = processorId || defaultProcessorId;

  try {
    const response = await fetch(
      `https://documentai.googleapis.com/v1/${processor}:process`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rawDocument: {
            content: pdfBase64,
            mimeType: 'application/pdf',
          },
          skipHumanReview: true,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Document AI API error ${response.status}: ${error}`);
    }

    const result = await response.json();
    return parseDocumentAIResponse(result);
    
  } catch (error) {
    console.error('Document AI processing failed:', error);
    throw error;
  }
}

/**
 * Document AI レスポンスを解析して構造化データに変換
 */
function parseDocumentAIResponse(response: any): DocumentAIResult {
  const document = response.document;
  const pages: DocumentAIPage[] = [];
  let fullText = '';
  let totalConfidence = 0;
  let blockCount = 0;

  document.pages?.forEach((page: any, index: number) => {
    const pageWidth = page.dimension?.width || 0;
    const pageHeight = page.dimension?.height || 0;
    
    const blocks: DocumentAIBlock[] = [];
    
    // テキストブロックを処理
    page.paragraphs?.forEach((paragraph: any) => {
      const textBlock = extractTextBlock(paragraph, pageWidth, pageHeight);
      if (textBlock) {
        blocks.push(textBlock);
        fullText += textBlock.text + '\n';
        totalConfidence += textBlock.confidence;
        blockCount++;
      }
    });

    // 表を処理
    page.tables?.forEach((table: any) => {
      const tableBlock = extractTableBlock(table, pageWidth, pageHeight);
      if (tableBlock) {
        blocks.push(tableBlock);
        fullText += tableBlock.text + '\n';
        totalConfidence += tableBlock.confidence;
        blockCount++;
      }
    });

    // フォームフィールドを処理
    page.formFields?.forEach((field: any) => {
      const formBlock = extractFormField(field, pageWidth, pageHeight);
      if (formBlock) {
        blocks.push(formBlock);
        fullText += formBlock.text + '\n';
        totalConfidence += formBlock.confidence;
        blockCount++;
      }
    });

    pages.push({
      pageNumber: index + 1,
      width: pageWidth,
      height: pageHeight,
      blocks,
    });
  });

  return {
    pages,
    fullText: fullText.trim(),
    metadata: {
      totalPages: pages.length,
      processingTime: response.metadata?.processingTime || 0,
      confidence: blockCount > 0 ? totalConfidence / blockCount : 0,
    },
  };
}

function extractTextBlock(paragraph: any, pageWidth: number, pageHeight: number): DocumentAIBlock | null {
  const layout = paragraph.layout;
  if (!layout) return null;

  const text = layout.text?.content || '';
  if (!text.trim()) return null;

  const bbox = layout.boundingBox;
  const confidence = layout.confidence || 0;

  return {
    id: layout.text?.anchor?.textSegments?.[0]?.segment?.startIndex || `text_${Date.now()}`,
    text,
    type: 'text',
    confidence,
    bbox: {
      x: (bbox?.x0 || 0) * pageWidth,
      y: (bbox?.y0 || 0) * pageHeight,
      width: ((bbox?.x1 || 1) - (bbox?.x0 || 0)) * pageWidth,
      height: ((bbox?.y1 || 1) - (bbox?.y0 || 0)) * pageHeight,
    },
    properties: extractTextProperties(paragraph),
  };
}

function extractTableBlock(table: any, pageWidth: number, pageHeight: number): DocumentAIBlock | null {
  const rows = table.tableRows || [];
  if (rows.length === 0) return null;

  let tableText = '';
  rows.forEach((row: any) => {
    const cells = row.cells || [];
    const rowText = cells.map((cell: any) => 
      cell.layout?.text?.content || ''
    ).join(' | ');
    tableText += rowText + '\n';
  });

  const bbox = table.layout?.boundingBox;
  const confidence = table.layout?.confidence || 0;

  return {
    id: `table_${Date.now()}`,
    text: tableText.trim(),
    type: 'table',
    confidence,
    bbox: {
      x: (bbox?.x0 || 0) * pageWidth,
      y: (bbox?.y0 || 0) * pageHeight,
      width: ((bbox?.x1 || 1) - (bbox?.x0 || 0)) * pageWidth,
      height: ((bbox?.y1 || 1) - (bbox?.y0 || 0)) * pageHeight,
    },
  };
}

function extractFormField(field: any, pageWidth: number, pageHeight: number): DocumentAIBlock | null {
  const fieldName = field.fieldName?.text?.content || '';
  const fieldValue = field.fieldValue?.text?.content || '';
  
  if (!fieldName && !fieldValue) return null;

  const text = `${fieldName}: ${fieldValue}`.trim();
  const bbox = field.fieldName?.layout?.boundingBox || field.fieldValue?.layout?.boundingBox;
  const confidence = field.fieldName?.layout?.confidence || field.fieldValue?.layout?.confidence || 0;

  return {
    id: `form_${Date.now()}`,
    text,
    type: 'form',
    confidence,
    bbox: {
      x: (bbox?.x0 || 0) * pageWidth,
      y: (bbox?.y0 || 0) * pageHeight,
      width: ((bbox?.x1 || 1) - (bbox?.x0 || 0)) * pageWidth,
      height: ((bbox?.y1 || 1) - (bbox?.y0 || 0)) * pageHeight,
    },
  };
}

function extractTextProperties(paragraph: any) {
  const style = paragraph.layout?.style;
  if (!style) return undefined;

  return {
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    isBold: style.bold || false,
    isItalic: style.italic || false,
  };
}

/**
 * 名刺情報を抽出（既存のビジネスカードワークフローとの統合用）
 */
export function extractBusinessCardInfo(documentAIResult: DocumentAIResult) {
  const { pages, fullText } = documentAIResult;
  const allBlocks = pages.flatMap(page => page.blocks);
  
  // テキストブロックから名刺情報を抽出
  const textBlocks = allBlocks.filter(block => block.type === 'text');
  const formFields = allBlocks.filter(block => block.type === 'form');
  
  // フォームフィールドから構造化データを抽出
  const cardInfo: Record<string, string> = {};
  
  formFields.forEach(field => {
    const text = field.text;
    const [key, value] = text.split(':').map(s => s.trim());
    
    if (key && value) {
      // キーの正規化
      const normalizedKey = normalizeFieldKey(key);
      cardInfo[normalizedKey] = value;
    }
  });
  
  // フォームフィールドがない場合はテキストから推測
  if (Object.keys(cardInfo).length === 0) {
    extractFromTextBlocks(textBlocks, cardInfo);
  }
  
  return {
    cardInfo,
    confidence: documentAIResult.metadata.confidence,
    blocks: allBlocks,
    fullText,
  };
}

function normalizeFieldKey(key: string): string {
  const keyMap: Record<string, string> = {
    '名前': 'name',
    '氏名': 'name',
    '会社名': 'company',
    '会社': 'company',
    '部署': 'department',
    '役職': 'title',
    '電話': 'phone',
    '携帯': 'mobile',
    'メール': 'email',
    '住所': 'address',
    'fax': 'fax',
    'url': 'url',
    'website': 'url',
  };
  
  return keyMap[key] || key.toLowerCase();
}

function extractFromTextBlocks(textBlocks: DocumentAIBlock[], cardInfo: Record<string, string>) {
  const allText = textBlocks.map(block => block.text).join(' ');
  
  // メールアドレスを検出
  const emailMatch = allText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
  if (emailMatch) cardInfo.email = emailMatch[0];
  
  // 電話番号を検出
  const phoneMatches = allText.match(/\b\d{2,4}[-\s]?\d{2,4}[-\s]?\d{4}\b/g);
  if (phoneMatches) {
    if (phoneMatches.length > 0) cardInfo.phone = phoneMatches[0];
    if (phoneMatches.length > 1) cardInfo.mobile = phoneMatches[1];
  }
  
  // URLを検出
  const urlMatch = allText.match(/https?:\/\/[^\s]+/);
  if (urlMatch) cardInfo.url = urlMatch[0];
}
