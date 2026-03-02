import { AnalyzeResponse, RebuildResponse } from '../types';

const API_URL = import.meta.env.VITE_API_URL as string;

if (!API_URL) {
  console.warn('VITE_API_URL is not set. Add it to .env.local');
}

export const healthCheck = async (): Promise<boolean> => {
  const res = await fetch(`${API_URL}/health`);
  const data = await res.json();
  return data.status === 'ok';
};

export const analyzePdf = async (file: File): Promise<AnalyzeResponse> => {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_URL}/analyze`, { method: 'POST', body: form });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `HTTP ${res.status}`);
  }
  return res.json();
};

export const rebuildPdf = async (
  pdfB64: string,
  edits: Record<string, string>,
  rawIdMap: Record<string, string[]>,
  dpi = 300,
): Promise<RebuildResponse> => {
  const res = await fetch(`${API_URL}/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdf_b64: pdfB64,
      edits,
      raw_id_map: rawIdMap,
      dpi,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || `HTTP ${res.status}`);
  }
  return res.json();
};
