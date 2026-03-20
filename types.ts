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
  // 印刷ツール
  TOOL_WRITING = 'TOOL_WRITING',           // 文章作成系
  TOOL_OCR = 'TOOL_OCR',                   // 文字起こし・OCR系
  TOOL_PDF_EDIT = 'TOOL_PDF_EDIT',         // PDF加工・修正・編集
  TOOL_PDF_COMPARE = 'TOOL_PDF_COMPARE',   // PDF比較
  TOOL_PROOFREAD = 'TOOL_PROOFREAD',       // 校閲・校正・ファクトチェック
  TOOL_TYPESET_SPEC = 'TOOL_TYPESET_SPEC', // 組版指示書作成・読み取り
  // 自動組版
  TOOL_DETECT_LAYOUT = 'TOOL_DETECT_LAYOUT', // レイアウト検出・プリセット化
  TOOL_VALIDATE_MS = 'TOOL_VALIDATE_MS',     // 原稿検証・第一レポート
}

// ── 原稿検証 & 第一レポート ──

export interface ManuscriptChunk {
  chunk_id: string;
  role: string;
  text: string;
  max_chars?: number;
}

export interface ValidationError {
  error_type: string;
  original_text: string;
  suggested_text: string;
  reason_ref: string;
  severity: 'error' | 'warning';
}

export interface ChunkDetail {
  chunk_id: string;
  component_type: string;
  status: 'OK' | 'NG';
  current_text: string;
  text_length: number;
  layout_constraint: any;
  validation_results: ValidationError[];
}

export interface ConsensusReport {
  status: 'pending' | 'needs_revision' | 'ready' | 'user_approved';
  total_chunks: number;
  error_count_overflow: number;
  error_count_rule: number;
  error_count_total: number;
  chunk_details: ChunkDetail[];
}

export interface ValidationReportResponse {
  success: boolean;
  report_id: string;
  consensus: ConsensusReport;
  rag_rules_used: number;
  rag_rules: Array<{
    rule_code: string;
    category: string;
    text: string;
    severity: string;
    similarity: number;
  }>;
}

export type FeedbackActionType = 'accept' | 'manual_override' | 'reject' | 'no_change';

export interface FeedbackInput {
  chunk_id: string;
  component_type?: string;
  action_type: FeedbackActionType;
  original_text?: string;
  ai_suggestion?: string;
  user_final_text?: string;
  error_type?: string;
  customer_name: string;
}

export interface FeedbackResponse {
  success: boolean;
  report_id: string;
  feedbacks_processed: number;
  rules_created: number;
  pdca_cycle: {
    plan: string;
    do: string;
    check: string;
    action: string;
  };
  results: Array<{
    chunk_id: string;
    action_type: string;
    rule_generated: boolean;
    generated_rule_text: string | null;
  }>;
}

// ── 自動組版 検出ワークフロー ──

export interface DetectedMargins {
  top_mm: number;
  bottom_mm: number;
  inside_mm: number;
  outside_mm: number;
}

export interface DetectedPageGeometry {
  margins: DetectedMargins;
  base_column_count: number;
  base_writing_mode: string;
}

export interface DetectedDesignTokens {
  primary_color: string;
  secondary_color?: string;
  base_font_family: string;
  heading_font_family?: string;
  base_font_size_q: number;
  base_line_height_q: number;
}

export interface DetectedComponent {
  component_code: string;
  component_name: string;
  semantic_tag: string;
  writing_mode: string;
  font_size_q: number;
  line_height_q: number;
  has_border: boolean;
  border_color?: string;
  border_radius?: string;
  has_background: boolean;
  background_color?: string;
  heading_font_size_q?: number;
  heading_color?: string;
  column_count: number;
  estimated_area_pct: number;
}

export interface DetectionResult {
  page_geometry: DetectedPageGeometry;
  design_tokens: DetectedDesignTokens;
  components: DetectedComponent[];
}

export interface DetectionSessionResult {
  success: boolean;
  session_id: string;
  globals_id: string;
  page_number: number;
  detection: {
    components_count: number;
    components: Array<{ code: string; id?: string; name?: string; error?: string }>;
    page_geometry: DetectedPageGeometry;
    design_tokens: DetectedDesignTokens;
  };
  validation: {
    errors_count: number;
    errors: Array<{ field: string; message: string; value: unknown }>;
    status: string;
  };
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
