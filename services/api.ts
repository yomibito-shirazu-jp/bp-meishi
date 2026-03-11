import { AnalyzeResponse, RebuildResponse } from '../types';
import { getConfig } from './config';

const getApiUrl = () => getConfig('VITE_API_URL');

export const healthCheck = async (): Promise<boolean> => {
  const res = await fetch(`${getApiUrl()}/health`);
  const data = await res.json();
  return data.status === 'ok';
};

export const analyzePdf = async (file: File): Promise<AnalyzeResponse> => {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${getApiUrl()}/analyze`, { method: 'POST', body: form });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `HTTP ${res.status}`);
  }
  return res.json();
};

export interface SpanOverride {
  text?: string;
  font_class?: string;
  size_pt?: number;
  origin?: [number, number];
}

export const rebuildPdf = async (
  pdfB64: string,
  edits: Record<string, string>,
  rawIdMap: Record<string, string[]>,
  dpi = 300,
  pageIndex = 0,
  clipRect?: [number, number, number, number],
  overrides?: Record<string, SpanOverride>,
): Promise<RebuildResponse> => {
  const res = await fetch(`${getApiUrl()}/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdf_b64: pdfB64,
      edits,
      overrides: overrides || {},
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
