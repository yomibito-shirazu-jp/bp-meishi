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

export interface JobInstruction {
  document_info: {
    creation_date: string;
    product_name: string;
    customer_name: string;
    order_number: string;
    pasteboard_creator: string;
  };
  typesetting_format: {
    finished_size: {
      format: string;
      width_mm: number | null;
      height_mm: number | null;
    };
    text_direction: string;
    font_size_q: number | null;
    font_size_pt: number | null;
    line_spacing: {
      size_q: number | null;
      size_pt: number | null;
    };
  };
  character_attributes: {
    fonts: {
      kanji: string;
      kana: string;
      alphanumeric: string;
      ruby: string;
    };
    all_fonts_used: { name: string; char_count: number }[];
  };
}

export interface AnalyzeResponse {
  pages: PageData[];
  pdf_b64: string;
  job_instruction?: JobInstruction;
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
  // AI ツール（今後追加時に拡張）
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
