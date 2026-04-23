import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CardProject } from '../types';
import { getConfig } from './config';

// ── Dynamic Supabase client ──
// Re-created automatically when URL / key changes (e.g. after Settings save).
let _client: SupabaseClient | null = null;
let _cachedUrl = '';
let _cachedKey = '';

const getSupabaseClient = (): SupabaseClient | null => {
  const url = getConfig('VITE_SUPABASE_URL');
  const key = getConfig('VITE_SUPABASE_ANON_KEY');
  if (!url || !key) {
    console.warn('Supabase credentials not set. Using localStorage fallback.');
    return null;
  }
  if (url === _cachedUrl && key === _cachedKey && _client) return _client;
  try {
    _client = createClient(url, key);
    _cachedUrl = url;
    _cachedKey = key;
    return _client;
  } catch {
    console.warn('Supabase init failed, using localStorage fallback.');
    return null;
  }
};

// ── localStorage fallback ──
// NOTE: base64 binary fields are stripped before writing to localStorage to
// avoid the ~5MB quota limit. Only metadata and spans are kept locally.

const STORAGE_KEY = 'bp_meishi_projects';

/** Remove large binary blobs before persisting to localStorage. */
const stripBinaries = (project: CardProject): CardProject => ({
  ...project,
  pdf_b64: '',
  original_png_b64: null,
  rebuilt_pdf_b64: null,
  rebuilt_png_b64: null,
});

const getLocal = (): CardProject[] => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
};

const setLocal = (projects: CardProject[]): void => {
  try {
    const slim = projects.map(stripBinaries);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch (err: any) {
    // Quota exceeded — remove the oldest entries and retry once
    if (err?.name === 'QuotaExceededError' || err?.code === 22) {
      console.warn('localStorage quota exceeded — pruning oldest entries.');
      try {
        const pruned = projects.map(stripBinaries).slice(0, 10); // keep newest 10
        localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
      } catch {
        console.error('localStorage still full after pruning. Data not persisted locally.');
      }
    } else {
      throw err;
    }
  }
};

// ── CRUD ──

// raw_id_map._meta に畳んである magazine フィールド等を各プロパティに復元
const hydrateProject = (p: any): CardProject => {
  if (!p || !p.raw_id_map || !p.raw_id_map._meta) return p as CardProject;
  const meta = p.raw_id_map._meta;
  return {
    ...p,
    document_type: p.document_type ?? meta.document_type ?? 'business_card',
    markdown: p.markdown ?? meta.markdown ?? undefined,
    original_markdown: p.original_markdown ?? meta.original_markdown ?? undefined,
    category: p.category ?? meta.category ?? undefined,
    page_index: p.page_index ?? meta.page_index ?? 0,
    clip_rect: p.clip_rect ?? meta.clip_rect ?? undefined,
  };
};

export const listProjects = async (): Promise<CardProject[]> => {
  const supabase = getSupabaseClient();
  if (!supabase) return getLocal().map(hydrateProject);
  try {
    const { data, error } = await supabase
      .from('card_projects')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(hydrateProject);
  } catch (err) {
    console.warn('Supabase listProjects failed, falling back to localStorage:', err);
    return getLocal().map(hydrateProject);
  }
};

export const getProject = async (id: string): Promise<CardProject | null> => {
  const supabase = getSupabaseClient();
  if (!supabase) return getLocal().find(p => p.id === id) || null;
  try {
    const { data, error } = await supabase
      .from('card_projects')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('Supabase getProject failed, falling back to localStorage:', err);
    return getLocal().find(p => p.id === id) || null;
  }
};

export const saveProject = async (project: CardProject): Promise<CardProject> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    const updated = { ...project, updated_at: new Date().toISOString() };
    const projects = getLocal();
    const idx = projects.findIndex(p => p.id === project.id);
    if (idx >= 0) projects[idx] = updated;
    else projects.unshift(updated);
    setLocal(projects);
    return updated;
  }

  // Build row with only columns known to exist in Supabase schema
  const row: Record<string, unknown> = {
    id: project.id,
    name: project.name,
    spans: project.spans,
    original_spans: project.original_spans,
    pdf_b64: project.pdf_b64,
    page_mm: project.page_mm,
    original_png_b64: project.original_png_b64,
    updated_at: new Date().toISOString(),
  };
  if (project.rebuilt_pdf_b64) row.rebuilt_pdf_b64 = project.rebuilt_pdf_b64;
  if (project.rebuilt_png_b64) row.rebuilt_png_b64 = project.rebuilt_png_b64;

  // Store page_index / clip_rect / magazine fields inside raw_id_map._meta
  // (avoids 400 errors when these columns don't exist in DB)
  if (project.raw_id_map || project.page_index !== undefined || project.clip_rect
      || project.document_type || project.markdown || project.category) {
    row.raw_id_map = {
      ...(project.raw_id_map || {}),
      _meta: {
        page_index: project.page_index ?? 0,
        clip_rect: project.clip_rect ?? null,
        document_type: project.document_type ?? 'business_card',
        markdown: project.markdown ?? null,
        original_markdown: project.original_markdown ?? null,
        category: project.category ?? null,
      },
    };
  }

  try {
    const { data, error } = await supabase
      .from('card_projects')
      .upsert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    // Supabase failed — fall back to localStorage (binaries are stripped to stay within quota)
    console.warn('Supabase save failed, falling back to localStorage:', err);
    const projects = getLocal();
    const idx = projects.findIndex(p => p.id === project.id);
    const updated = { ...project, updated_at: new Date().toISOString() };
    if (idx >= 0) projects[idx] = updated;
    else projects.unshift(updated);
    setLocal(projects); // stripBinaries applied inside setLocal
    return updated;
  }
};

export const deleteProject = async (id: string): Promise<void> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    setLocal(getLocal().filter(p => p.id !== id));
    return;
  }
  const { error } = await supabase
    .from('card_projects')
    .delete()
    .eq('id', id);
  if (error) throw error;
};
