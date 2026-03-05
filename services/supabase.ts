import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CardProject } from '../types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

let supabase: SupabaseClient | null = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
  } catch {
    console.warn('Supabase init failed, using localStorage fallback.');
  }
} else {
  console.warn('Supabase credentials not set. Using localStorage fallback.');
}

// ── localStorage fallback ──

const STORAGE_KEY = 'bp_meishi_projects';

const getLocal = (): CardProject[] => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
};

const setLocal = (projects: CardProject[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
};

// ── CRUD ──

export const listProjects = async (): Promise<CardProject[]> => {
  if (!supabase) return getLocal();
  try {
    const { data, error } = await supabase
      .from('card_projects')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    console.warn('Supabase listProjects failed, falling back to localStorage:', err);
    return getLocal();
  }
};

export const getProject = async (id: string): Promise<CardProject | null> => {
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
  if (!supabase) {
    const projects = getLocal();
    const idx = projects.findIndex(p => p.id === project.id);
    const updated = { ...project, updated_at: new Date().toISOString() };
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

  // Store page_index / clip_rect inside raw_id_map as _meta
  // (avoids 400 errors when these columns don't exist in DB)
  if (project.raw_id_map || project.page_index !== undefined || project.clip_rect) {
    row.raw_id_map = {
      ...(project.raw_id_map || {}),
      _meta: { page_index: project.page_index ?? 0, clip_rect: project.clip_rect ?? null },
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
    console.warn('Supabase save failed, falling back to localStorage:', err);
    const projects = getLocal();
    const idx = projects.findIndex(p => p.id === project.id);
    const updated = { ...project, updated_at: new Date().toISOString() };
    if (idx >= 0) projects[idx] = updated;
    else projects.unshift(updated);
    setLocal(projects);
    return updated;
  }
};

export const deleteProject = async (id: string): Promise<void> => {
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
