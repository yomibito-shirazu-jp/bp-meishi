import { AnalyzeResponse, RebuildResponse } from '../types';
import { getConfig } from './config';

const getApiUrl = () => getConfig('VITE_API_URL');

export const healthCheck = async (): Promise<boolean> => {
  const res = await fetch(`${getApiUrl()}/health`);
  const data = await res.json();
  return data.status === 'ok';
};

// 利用可能な PDF 検出エンジン (プライマリ)。'auto' はサーバ側デフォルト動作。
export type ExtractEngine =
  | 'auto'
  | 'docai'      // Google Document AI
  | 'yomitoku'   // YomiToku (日本語OCR, 縦書き対応)
  | 'vision_ocr' // Google Cloud Vision DOCUMENT_TEXT_DETECTION
  | 'pymupdf'    // PyMuPDF (テキスト埋め込みPDF高速抽出)
  | 'gemini'     // Gemini Vision
  | 'docling'    // docling (IBM, ML文書構造解析)
  | 'huridocs';  // huridocs/pdf-document-layout-analysis (VGT/LayoutLMv3)

export const EXTRACT_ENGINE_LABELS: Record<ExtractEngine, string> = {
  auto: '自動 (推奨)',
  docai: 'Document AI',
  yomitoku: 'YomiToku (日本語OCR)',
  vision_ocr: 'Cloud Vision OCR (手書き)',
  pymupdf: 'PyMuPDF (テキスト埋込)',
  gemini: 'Gemini Vision',
  docling: 'docling (IBM)',
  huridocs: 'huridocs (VGT/LayoutLMv3)',
};

export type DocumentProfile = 'business_card' | 'magazine' | 'poster';

export interface AnalyzeOptions {
  /** プライマリ検出エンジンを明示指定 (指定時は他の use* フラグより優先) */
  engine?: ExtractEngine;
  /** ドキュメント種別。未指定時は business_card。magazine は縦書き/多段組想定で
   *  Vision/Gemini の画像bbox検出をスキップし、既定エンジンを yomitoku に寄せる。 */
  profile?: DocumentProfile;
  useDocumentAI?: boolean;
  useYomitoku?: boolean;
  yomitokuLite?: boolean;
  yomitokuDevice?: 'cpu' | 'cuda';
  /**
   * 手書き日本語スキャンに強い Cloud Vision DOCUMENT_TEXT_DETECTION を
   * プライマリ抽出エンジンに指定する。明示しない場合でもバックエンドは
   * DocAI が空を返したら自動で Vision OCR にフォールバックする。
   */
  useVisionOcr?: boolean;
}

export interface ExtractEngineStatus {
  id: ExtractEngine;
  label: string;
  available: boolean;
  install_hint?: string;
}

export const listExtractEngines = async (): Promise<ExtractEngineStatus[]> => {
  try {
    const res = await fetch(`${getApiUrl()}/extract-engines`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length) return data;
    throw new Error('empty');
  } catch {
    return (Object.keys(EXTRACT_ENGINE_LABELS) as ExtractEngine[]).map(id => ({
      id, label: EXTRACT_ENGINE_LABELS[id], available: true,
    }));
  }
};

export const analyzePdf = async (
  file: File,
  opts?: boolean | AnalyzeOptions,
): Promise<AnalyzeResponse> => {
  const form = new FormData();
  form.append('file', file);

  // 後方互換: 第二引数 boolean は useDocumentAI として扱う
  const options: AnalyzeOptions = typeof opts === 'boolean'
    ? { useDocumentAI: opts }
    : (opts ?? {});

  const headers: Record<string, string> = {};

  // Document profile (magazine/poster 時は雑誌向け挙動にスイッチ)
  // エンジン既定はバックエンド側で profile を見て自動選択する
  // (yomitoku 優先 → docling → docai の順でインストール状況に応じてフォールバック)
  if (options.profile) {
    headers['X-Document-Profile'] = options.profile;
  }

  // engine 明示指定がある場合はそれを優先 (use* フラグへマッピング)
  if (options.engine && options.engine !== 'auto') {
    headers['X-Extract-Engine'] = options.engine;
    if (options.engine === 'yomitoku') options.useYomitoku = true;
    else if (options.engine === 'vision_ocr') options.useVisionOcr = true;
    else if (options.engine === 'docai') options.useDocumentAI = true;
    else if (options.engine === 'docling' || options.engine === 'pymupdf' || options.engine === 'gemini') {
      options.useDocumentAI = false;
      options.useYomitoku = false;
      options.useVisionOcr = false;
    }
  }

  const useYomitoku = options.useYomitoku
    ?? (getConfig('VITE_USE_YOMITOKU').toLowerCase() === 'true');
  if (useYomitoku) {
    headers['X-Use-Yomitoku'] = 'true';
    const lite = options.yomitokuLite
      ?? (getConfig('VITE_YOMITOKU_LITE').toLowerCase() !== 'false');
    const device = options.yomitokuDevice
      ?? ((getConfig('VITE_YOMITOKU_DEVICE') || 'cpu') as 'cpu' | 'cuda');
    headers['X-Yomitoku-Lite'] = lite ? 'true' : 'false';
    headers['X-Yomitoku-Device'] = device;
  }

  // Vision OCR プライマリ指定 (手書き日本語スキャン用、YomiToku 未使用時のみ)
  const useVisionOcr = !useYomitoku && (
    options.useVisionOcr ?? (getConfig('VITE_USE_VISION_OCR').toLowerCase() === 'true')
  );
  if (useVisionOcr) {
    headers['X-Use-Vision-OCR'] = 'true';
  }

  // YomiToku / Vision OCR 使用時は Document AI プライマリはスキップ
  const useDocAI = !useYomitoku && !useVisionOcr && (
    options.useDocumentAI ?? (getConfig('VITE_USE_DOCUMENT_AI') !== 'false')
  );
  if (useDocAI) {
    headers['X-Use-DocumentAI'] = 'true';
    const projectId = getConfig('VITE_GOOGLE_PROJECT_ID');
    const location = getConfig('VITE_DOCUMENT_AI_LOCATION');
    const processorId = getConfig('VITE_DOCUMENT_AI_PROCESSOR_ID');
    const versionId = getConfig('VITE_DOCUMENT_AI_VERSION_ID');
    if (projectId) headers['X-Project-ID'] = projectId;
    if (location) headers['X-Location'] = location;
    if (processorId) headers['X-Processor-ID'] = processorId;
    if (versionId) headers['X-Version-ID'] = versionId;
  }

  const res = await fetch(`${getApiUrl()}/analyze`, {
    method: 'POST',
    body: form,
    headers,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `HTTP ${res.status}`);
  }
  return res.json();
};

export interface YomitokuStatus {
  available: boolean;
  version?: string;
  install_hint?: string;
}

export const getYomitokuStatus = async (): Promise<YomitokuStatus> => {
  const res = await fetch(`${getApiUrl()}/yomitoku-status`);
  if (!res.ok) return { available: false };
  return res.json();
};

export interface SpanOverride {
  text?: string;
  font_class?: string;
  font_original?: string;
  size_pt?: number;
  origin?: [number, number];
  writing_direction?: 'horizontal' | 'vertical';
  x_pct?: number;
  y_pct?: number;
  w_pct?: number;
  h_pct?: number;
}

export interface SpanBbox {
  bbox: [number, number, number, number];
  origin: [number, number];
  font_class: string;
  font_original: string;
  size_pt: number;
}

export interface RedactRect {
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
}

export const rebuildPdf = async (
  pdfB64: string,
  edits: Record<string, string>,
  rawIdMap: Record<string, string[]>,
  dpi = 300,
  pageIndex = 0,
  clipRect?: [number, number, number, number],
  overrides?: Record<string, SpanOverride>,
  originalTexts?: Record<string, string>,
  imageReplacements?: Record<string, { xref: number; data_b64: string; mime_type?: string; rect?: [number, number, number, number] }>,
  spanBboxes?: Record<string, SpanBbox>,
  redactRects?: RedactRect[],
): Promise<RebuildResponse> => {
  const res = await fetch(`${getApiUrl()}/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdf_b64: pdfB64,
      edits,
      original_texts: originalTexts || {},
      overrides: overrides || {},
      image_replacements: imageReplacements || {},
      span_bboxes: spanBboxes || {},
      redact_rects: redactRects || [],
      raw_id_map: rawIdMap,
      dpi,
      page_index: pageIndex,
      clip_rect: clipRect || null,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `HTTP ${res.status}`);
  }
  return res.json();
};

export interface VivliostyleSpan {
  text: string;
  font_class: string;
  size_pt: number;
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
}

export interface VivliostyleBuildResponse {
  pdf_b64: string;
  html: string;
  css: string;
  engine: string;
  version: string;
}

export const vivliostyleBuild = async (
  spans: VivliostyleSpan[],
  pageMM: [number, number],
  title: string = '名刺',
  bgImageB64?: string,
  rawHtml?: string,
  rawCss?: string,
  saveDirName?: string,
  images?: { id: string; b64: string }[],
): Promise<VivliostyleBuildResponse> => {
  const res = await fetch(`${getApiUrl()}/vivliostyle-build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spans: spans.map(s => ({
        text: s.text,
        font_class: s.font_class,
        size_pt: s.size_pt,
        x_pct: s.x_pct,
        y_pct: s.y_pct,
        w_pct: s.w_pct,
        h_pct: s.h_pct,
      })),
      page_mm: pageMM,
      title,
      bg_image_b64: bgImageB64,
      raw_html: rawHtml,
      raw_css: rawCss,
      save_dir_name: saveDirName,
      images: images || [],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `HTTP ${res.status}`);
  }
  return res.json();
};

export interface ExtractInstructionRequest {
  content_text: string;
  analyze_data?: any;
}

export const extractInstruction = async (req: ExtractInstructionRequest): Promise<any> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  
  const res = await fetch(`${getApiUrl()}/agent/extract-instruction`, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `Extract Instruction API Error: HTTP ${res.status}`);
  }
  return res.json();
};

// ── Vision API ──────────────────────────────────────────────────────────────

export interface VisionLabel { description: string; score: number; }
export interface VisionObject { name: string; score: number; bbox: { x: number; y: number }[]; }
export interface VisionWebResult {
  best_guess_labels: { label: string; language: string }[];
  web_entities: { description: string; score: number }[];
  visually_similar_images: { url: string }[];
  pages_with_matching_images: { url: string; title: string }[];
}
export interface VisionDominantColor {
  r: number; g: number; b: number;
  score: number; pixel_fraction: number;
}
export interface VisionAnalyzeResult {
  labels: VisionLabel[];
  texts: { text: string; bbox: { x: number; y: number }[] }[];
  logos: VisionLabel[];
  objects: VisionObject[];
  web: VisionWebResult;
  safe_search: Record<string, string>;
  dominant_colors: VisionDominantColor[];
  full_text: string;
}

export const visionAnalyze = async (imageB64: string): Promise<VisionAnalyzeResult> => {
  const res = await fetch(`${getApiUrl()}/vision-analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_b64: imageB64 }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `Vision API Error: HTTP ${res.status}`);
  }
  return res.json();
};

// ── MarkItDown Pipeline ──

export interface MarkdownPage {
  page_index: number;
  width_mm: number;
  height_mm: number;
  width_px: number;
  height_px: number;
  preview_b64: string;
}

export interface AnalyzeMarkdownResponse {
  markdown: string;
  pages: MarkdownPage[];
  total_pages: number;
  source?: string;
  accuracy_score?: number;
  verification_notes?: string;
  markitdown_md?: string;
  gemini_md?: string;
  docai_md?: string;
  sources_available?: string[];
}

export const analyzeMarkdown = async (pdfB64: string): Promise<AnalyzeMarkdownResponse> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${getApiUrl()}/analyze-markdown`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pdf_b64: pdfB64 }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `Markdown 解析エラー: HTTP ${res.status}`);
  }
  return res.json();
};

export interface MarkdownToPdfResponse {
  pdf_b64: string;
  preview_pngs: string[];
  engine?: string;
}

export interface MarkdownToPdfOptions {
  theme?: 'default' | 'academic' | 'business';
  format?: 'A4' | 'A5' | 'B5' | 'Letter';
  vertical?: boolean;
  title?: string;
  author?: string;
  page_numbers?: boolean;
  toc?: boolean;
  custom_css?: string;
}

export const markdownToPdf = async (
  markdownText: string,
  pageMM: [number, number],
  originalPdfB64?: string,
  bgImageB64?: string,
  options?: MarkdownToPdfOptions,
): Promise<MarkdownToPdfResponse> => {
  const res = await fetch(`${getApiUrl()}/markdown-to-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: markdownText,
      page_mm: pageMM,
      original_pdf_b64: originalPdfB64 || null,
      bg_image_b64: bgImageB64 || null,
      ...(options || {}),
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `PDF生成エラー: HTTP ${res.status}`);
  }
  return res.json();
};

// ── DTP Agent & Imagen API ──────────────────────────────────────────────────

export interface DtpAgentRequest {
  instruction_manual: any;
  content_text: string;
}

export interface DtpAgentResponse {
  html: string;
  css: string;
}

export const dtpAgentLayout = async (req: DtpAgentRequest): Promise<DtpAgentResponse> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  
  const res = await fetch(`${getApiUrl()}/agent/dtp-layout`, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `DTP Agent API Error: HTTP ${res.status}`);
  }
  return res.json();
};

export interface GenerateImageRequest {
  prompt: string;
  aspect_ratio?: string;
  model?: string;
}

export interface GenerateImageResponse {
  images: { data_b64: string; saved_path?: string }[];
}

export const generateImage = async (req: GenerateImageRequest): Promise<GenerateImageResponse> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  
  const res = await fetch(`${getApiUrl()}/generate-image`, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `Image Generation API Error: HTTP ${res.status}`);
  }
  return res.json();
};

// ── 修正指示PDF解析 (赤ペン指示書) ──

export interface CorrectionTask {
  id: string;
  page: number;
  location: string;
  original_text: string;
  corrected_text: string;
  instruction: string;
  category: 'text' | 'image' | 'layout' | 'delete' | 'add';
  priority: 'high' | 'normal' | 'low';
  status: 'pending' | 'done' | 'skipped';
}

export interface ExtractCorrectionsResponse {
  tasks: CorrectionTask[];
  total_tasks: number;
  pages: { page_index: number; preview_b64: string; width: number; height: number; }[];
}

export const extractCorrections = async (
  correctionPdfB64: string,
  manuscriptPdfB64?: string,
): Promise<ExtractCorrectionsResponse> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const geminiKey = getConfig('VITE_GOOGLE_AI_KEY');
  if (geminiKey) headers['X-Gemini-API-Key'] = geminiKey;
  const res = await fetch(`${getApiUrl()}/extract-corrections`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pdf_b64: correctionPdfB64,
      manuscript_pdf_b64: manuscriptPdfB64 || null,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `修正指示抽出エラー: HTTP ${res.status}`);
  }
  return res.json();
};
