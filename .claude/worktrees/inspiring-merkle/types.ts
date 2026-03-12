export interface Span {
  id: string;
  text: string;
  font_original: string;
  font_class: 'gothic' | 'mincho' | 'light' | 'gothic_bold';
  size_pt: number;
  origin: [number, number];
  bbox: [number, number, number, number];
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
}

export interface ImageInfo {
  id: string;
  bbox: [number, number, number, number];
}

export interface DrawingInfo {
  bbox: [number, number, number, number];
  fill: [number, number, number] | null;
  color: [number, number, number] | null;
}

export interface PageData {
  page_index: number;
  page_label?: string;
  page_pt: [number, number];
  page_mm: [number, number];
  spans: Span[];
  raw_id_map: Record<string, string[]>;
  images: ImageInfo[];
  drawings: DrawingInfo[];
  original_png_b64: string;
  clip_rect: [number, number, number, number];
}

export interface AnalyzeResponse {
  pages: PageData[];
  pdf_b64: string;
}

export interface RebuildResponse {
  pdf_b64: string;
  png_b64: string;
}

export interface CardProject {
  id: string;
  name: string;
  spans: Span[];
  original_spans: Span[];
  pdf_b64: string;
  page_mm: [number, number];
  original_png_b64: string | null;
  rebuilt_pdf_b64?: string | null;
  rebuilt_png_b64?: string | null;
  raw_id_map?: Record<string, string[]>;
  page_index?: number;
  clip_rect?: [number, number, number, number];
  created_at: string;
  updated_at: string;
}

export enum AppState {
  DASHBOARD = 'DASHBOARD',
  EDIT = 'EDIT',
  INBOX = 'INBOX',
  AI_CHAT = 'AI_CHAT',
  SETTINGS = 'SETTINGS',
  // 文字起こし
  TRANSCRIBE_LIST = 'TRANSCRIBE_LIST',
  TRANSCRIBE_HISTORY = 'TRANSCRIBE_HISTORY',
  TRANSCRIBE_AI = 'TRANSCRIBE_AI',
  // 自動組版
  TYPESET_LIST = 'TYPESET_LIST',
  TYPESET_HISTORY = 'TYPESET_HISTORY',
  TYPESET_AI = 'TYPESET_AI',
}

export interface TranscribeProject {
  id: string;
  name: string;
  source_type: 'drive' | 'upload';
  source_url?: string;
  text: string;
  ai_results: AiResult[];
  consensus_text?: string;
  created_at: string;
  updated_at: string;
}

export interface AiResult {
  model: string;      // 'gemini' | 'vision' | 'vertex'
  text: string;
  confidence?: number;
}

// ── 自動組版 (DTP Automation) ──

export type DtpTaskStatus = 'pending' | 'processing' | 'review' | 'completed' | 'failed';

export type DtpOperationType =
  | 'correction'     // AI原稿修正
  | 'ps_edit'        // Photoshop編集
  | 'id_layout'      // InDesignレイアウト
  | 'ai_vector'      // Illustratorベクター
  | 'pdf_merge'      // PDF結合
  | 'pdf_split'      // PDF分割
  | 'pdf_compress'   // PDF圧縮
  | 'pdf_ocr';       // PDF OCR

export interface DtpFile {
  id: string;
  name: string;
  mime_type: string;
  size_bytes?: number;
  data_b64?: string;
  drive_file_id?: string;
  preview_png_b64?: string;
  page_count?: number;
}

export interface DtpCorrection {
  page: number;
  location: string;
  original_text: string;
  corrected_text: string;
  reason: string;
  applied: boolean;
}

export interface DtpTask {
  id: string;
  name: string;
  description?: string;
  status: DtpTaskStatus;
  operation: DtpOperationType;
  input_files: DtpFile[];
  output_files: DtpFile[];
  params: Record<string, any>;
  correction_instructions?: string;
  corrections?: DtpCorrection[];
  error_message?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}
