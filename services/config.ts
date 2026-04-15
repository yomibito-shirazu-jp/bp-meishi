/**
 * Centralised config resolver.
 *
 * Priority:  localStorage override  >  .env.local (import.meta.env)  >  ''
 *
 * Call `getConfig(key)` anywhere to get the live value.
 * Call `saveConfig(key, value)` from the Settings UI to persist a new value.
 * Call `clearConfig(key)` to remove a localStorage override and revert to env.
 */

export const CONFIG_KEYS = [
  'VITE_API_URL',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_GOOGLE_AI_KEY',
  'VITE_GOOGLE_CLIENT_ID',
  'VITE_GOOGLE_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'VITE_TYPESETTING_URL',
  'VITE_TYPESETTING_ANON_KEY',
  'VITE_GOOGLE_PROJECT_ID',
  'VITE_GOOGLE_PROJECT_NUMBER',
  'VITE_DOCUMENT_AI_LOCATION',
  'VITE_DOCUMENT_AI_PROCESSOR_ID',
  'VITE_DOCUMENT_AI_VERSION_ID',
  'VITE_USE_DOCUMENT_AI',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

const LS_KEY = 'bp_meishi_settings';

const loadAll = (): Partial<Record<ConfigKey, string>> => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
};

/** Get the current value of a config key (localStorage overrides env). */
export const getConfig = (key: ConfigKey): string => {
  const overrides = loadAll();
  if (overrides[key] !== undefined && overrides[key] !== '') return overrides[key]!;
  return (import.meta.env[key] as string) || '';
};

/** Persist a new value for a config key. Empty strings are ignored (existing value kept). */
export const saveConfig = (key: ConfigKey, value: string): void => {
  if (value.trim() === '') return; // 空なら既存値を維持
  const overrides = loadAll();
  overrides[key] = value.trim();
  localStorage.setItem(LS_KEY, JSON.stringify(overrides));
};

/** Returns all overrides stored in localStorage (not env values). */
export const getAllOverrides = (): Partial<Record<ConfigKey, string>> => loadAll();

/** Returns true when the key has a value (either from localStorage or env). */
export const isConfigured = (key: ConfigKey): boolean => !!getConfig(key);
