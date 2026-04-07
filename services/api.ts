import { AnalyzeResponse, RebuildResponse } from '../types';
import { getConfig } from './config';

const getApiUrl = () => getConfig('VITE_API_URL');

export const healthCheck = async (): Promise<boolean> => {
  const res = await fetch(`${getApiUrl()}/health`);
  const data = await res.json();
  return data.status === 'ok';
};

export const analyzePdf = async (file: File, useDocumentAI?: boolean): Promise<AnalyzeResponse> => {
  const form = new FormData();
  form.append('file', file);
  
  const headers: Record<string, string> = {};
  const geminiKey = getConfig('VITE_GOOGLE_AI_KEY');
  if (geminiKey) {
    headers['X-Gemini-API-Key'] = geminiKey;
  }
  const useDocAI = useDocumentAI ?? (getConfig('VITE_USE_DOCUMENT_AI') === 'true');
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
    headers
  });
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
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `HTTP ${res.status}`);
  }
  return res.json();
};
