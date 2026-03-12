/**
 * DTP Automation API クライアント
 *
 * バックエンドの /dtp/* エンドポイントと通信する。
 * Adobe Bridge (Socket.IO) + PyMuPDF + Gemini AI を統合。
 */
import { DtpOperationType } from '../types';
import { getConfig } from './config';

const getApiUrl = (): string => {
  const url = getConfig('VITE_API_URL') || import.meta.env.VITE_API_URL || '';
  return (url as string).replace(/\/$/, '');
};

const handleError = async (res: Response): Promise<never> => {
  const e = await res.json().catch(() => ({}));
  throw new Error(e.detail || `HTTP ${res.status}`);
};

// ── Preview ──

export interface DtpPreviewResponse {
  preview_png_b64: string;
  page_count: number;
  pages: Array<{ index: number; width_mm: number; height_mm: number }>;
}

export const dtpPreview = async (pdfB64: string, pageIndex = 0): Promise<DtpPreviewResponse> => {
  const res = await fetch(`${getApiUrl()}/dtp/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_b64: pdfB64, page_index: pageIndex }),
  });
  if (!res.ok) return handleError(res);
  return res.json();
};

// ── AI Correction ──

export interface DtpCorrectionItem {
  page: number;
  location: string;
  original_text: string;
  corrected_text: string;
  reason: string;
}

export interface DtpCorrectionResponse {
  corrections: DtpCorrectionItem[];
  corrected_pdf_b64: string | null;
  preview_png_b64: string | null;
}

export const dtpCorrect = async (
  pdfB64: string,
  instructions: string,
  pageIndices: number[] = [],
): Promise<DtpCorrectionResponse> => {
  const res = await fetch(`${getApiUrl()}/dtp/correct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_b64: pdfB64, instructions, page_indices: pageIndices }),
  });
  if (!res.ok) return handleError(res);
  return res.json();
};

// ── Execute Operation ──

export interface DtpOutputFile {
  id: string;
  name: string;
  mime_type: string;
  data_b64: string;
  preview_png_b64?: string;
  size_bytes?: number;
}

export interface DtpExecuteResponse {
  output_files: DtpOutputFile[];
  adobe_response?: any;
  original_size?: number;
  compressed_size?: number;
}

export const dtpExecute = async (
  operation: DtpOperationType,
  files: Array<{ name: string; data_b64: string }>,
  params: Record<string, any> = {},
): Promise<DtpExecuteResponse> => {
  const res = await fetch(`${getApiUrl()}/dtp/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, files, params }),
  });
  if (!res.ok) return handleError(res);
  return res.json();
};

// ── Adobe Direct Command ──

export const dtpAdobeCommand = async (
  application: string,
  action: string,
  options: Record<string, any> = {},
): Promise<any> => {
  const res = await fetch(`${getApiUrl()}/dtp/adobe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ application, action, options }),
  });
  if (!res.ok) return handleError(res);
  return res.json();
};

// ── Status ──

export interface DtpStatusResponse {
  proxy_connected: boolean;
  proxy_url: string;
  pymupdf: string;
  gemini_configured: boolean;
}

export const dtpStatus = async (): Promise<DtpStatusResponse> => {
  const res = await fetch(`${getApiUrl()}/dtp/status`);
  if (!res.ok) return handleError(res);
  return res.json();
};
