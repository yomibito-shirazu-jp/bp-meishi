import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CardProject, DtpTask } from '../types';

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

// ── DTP Tasks CRUD ──

const DTP_STORAGE_KEY = 'bp_dtp_tasks';

const stripDtpBinaries = (task: DtpTask): DtpTask => ({
  ...task,
  input_files: task.input_files.map(f => ({ ...f, data_b64: undefined, preview_png_b64: undefined })),
  output_files: task.output_files.map(f => ({ ...f, data_b64: undefined, preview_png_b64: undefined })),
});

const getDtpLocal = (): DtpTask[] => {
  try { return JSON.parse(localStorage.getItem(DTP_STORAGE_KEY) || '[]'); }
  catch { return []; }
};

const setDtpLocal = (tasks: DtpTask[]): void => {
  try {
    const slim = tasks.map(stripDtpBinaries);
    localStorage.setItem(DTP_STORAGE_KEY, JSON.stringify(slim));
  } catch (err: any) {
    if (err?.name === 'QuotaExceededError' || err?.code === 22) {
      try {
        const pruned = tasks.map(stripDtpBinaries).slice(0, 20);
        localStorage.setItem(DTP_STORAGE_KEY, JSON.stringify(pruned));
      } catch { /* give up */ }
    }
  }
};

export const listDtpTasks = async (): Promise<DtpTask[]> => {
  if (!supabase) return getDtpLocal();
  try {
    const { data, error } = await supabase
      .from('dtp_tasks')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  } catch {
    return getDtpLocal();
  }
};

export const saveDtpTask = async (task: DtpTask): Promise<DtpTask> => {
  const updated = { ...task, updated_at: new Date().toISOString() };
  if (!supabase) {
    const tasks = getDtpLocal();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) tasks[idx] = updated;
    else tasks.unshift(updated);
    setDtpLocal(tasks);
    return updated;
  }

  try {
    const { data, error } = await supabase
      .from('dtp_tasks')
      .upsert({
        id: task.id,
        name: task.name,
        description: task.description,
        status: task.status,
        operation: task.operation,
        input_files: task.input_files,
        output_files: task.output_files,
        params: task.params,
        correction_instructions: task.correction_instructions,
        corrections: task.corrections,
        error_message: task.error_message,
        updated_at: new Date().toISOString(),
        completed_at: task.completed_at,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch {
    const tasks = getDtpLocal();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) tasks[idx] = updated;
    else tasks.unshift(updated);
    setDtpLocal(tasks);
    return updated;
  }
};

export const deleteDtpTask = async (id: string): Promise<void> => {
  if (!supabase) {
    setDtpLocal(getDtpLocal().filter(t => t.id !== id));
    return;
  }
  const { error } = await supabase
    .from('dtp_tasks')
    .delete()
    .eq('id', id);
  if (error) throw error;
};
