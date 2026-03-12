/**
 * Runtime config — localStorage overrides for environment variables.
 * Settings page で保存した値を VITE_* の代わりに使用する。
 */

export type ConfigKey =
  | 'VITE_API_URL'
  | 'VITE_SUPABASE_URL'
  | 'VITE_SUPABASE_ANON_KEY'
  | 'VITE_GOOGLE_AI_KEY';

const STORAGE_KEY = 'bp_config_overrides';

const loadOverrides = (): Partial<Record<ConfigKey, string>> => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
};

export const getAllOverrides = (): Partial<Record<ConfigKey, string>> => loadOverrides();

export const getConfig = (key: ConfigKey): string => {
  const overrides = loadOverrides();
  if (overrides[key]) return overrides[key]!;
  return (import.meta.env[key] as string) || '';
};

export const saveConfig = (key: ConfigKey, value: string): void => {
  const overrides = loadOverrides();
  if (value) {
    overrides[key] = value;
  } else {
    delete overrides[key];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
};
