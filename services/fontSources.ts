import { getConfig } from './config';

export type FontSourceMode = 'local' | 'nextcloud' | 'hybrid';

export interface FontCatalogItem {
  id: string;
  source: 'local' | 'nextcloud';
  path: string;
  family: string;
  format: string;
  sizeBytes?: number;
}

export interface FontCatalogResponse {
  fonts: FontCatalogItem[];
  warnings: string[];
}

export interface FontCatalogOverrides {
  mode?: FontSourceMode;
  localRoots?: string[];
  nextcloud?: {
    baseUrl?: string;
    username?: string;
    appPassword?: string;
    paths?: string[];
  };
}

const csvToList = (value: string): string[] =>
  value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

export const buildFontCatalogRequest = (overrides?: FontCatalogOverrides) => {
  const nextcloudOverrides = overrides?.nextcloud || {};
  return {
    mode: overrides?.mode ?? ((getConfig('VITE_FONT_SOURCE_MODE') || 'hybrid') as FontSourceMode),
    localRoots: overrides?.localRoots ?? csvToList(getConfig('VITE_LOCAL_FONT_ROOTS')),
    nextcloud: {
      baseUrl: nextcloudOverrides.baseUrl ?? getConfig('VITE_NEXTCLOUD_BASE_URL'),
      username: nextcloudOverrides.username ?? getConfig('VITE_NEXTCLOUD_USERNAME'),
      appPassword: nextcloudOverrides.appPassword ?? getConfig('VITE_NEXTCLOUD_APP_PASSWORD'),
      paths: nextcloudOverrides.paths ?? csvToList(getConfig('VITE_NEXTCLOUD_FONT_PATHS')),
    },
  };
};

export async function fetchFontCatalog(signal?: AbortSignal, overrides?: FontCatalogOverrides): Promise<FontCatalogResponse> {
  const base = (getConfig('VITE_MCP_BRIDGE_URL') || 'http://127.0.0.1:8787').replace(/\/$/, '');
  const res = await fetch(`${base}/fonts/catalog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildFontCatalogRequest(overrides)),
    signal,
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`font catalog failed: HTTP ${res.status} ${msg}`);
  }
  return res.json();
}
