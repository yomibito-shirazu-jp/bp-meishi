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
}
