import { createClient } from '@supabase/supabase-js';
import { CardProject, Span } from '../types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseKey);

// ── Card Projects CRUD ──

export const listProjects = async (): Promise<CardProject[]> => {
  const { data, error } = await supabase
    .from('card_projects')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
};

export const getProject = async (id: string): Promise<CardProject | null> => {
  const { data, error } = await supabase
    .from('card_projects')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const saveProject = async (project: CardProject): Promise<CardProject> => {
  const { data, error } = await supabase
    .from('card_projects')
    .upsert({
      id: project.id,
      name: project.name,
      spans: project.spans,
      original_spans: project.original_spans,
      pdf_b64: project.pdf_b64,
      page_mm: project.page_mm,
      original_png_b64: project.original_png_b64,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteProject = async (id: string): Promise<void> => {
  const { error } = await supabase
    .from('card_projects')
    .delete()
    .eq('id', id);
  if (error) throw error;
};
