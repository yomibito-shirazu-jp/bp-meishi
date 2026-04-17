import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFontCatalogRequest, fetchFontCatalog } from './fontSources';

const env = import.meta.env as Record<string, string>;

describe('fontSources', () => {
  beforeEach(() => {
    localStorage.clear();
    env.VITE_FONT_SOURCE_MODE = 'hybrid';
    env.VITE_LOCAL_FONT_ROOTS = '/fonts/a,/fonts/b';
    env.VITE_NEXTCLOUD_BASE_URL = 'https://cloud.example.com';
    env.VITE_NEXTCLOUD_USERNAME = 'alice';
    env.VITE_NEXTCLOUD_APP_PASSWORD = 'secret';
    env.VITE_NEXTCLOUD_FONT_PATHS = '/Fonts/A,/Fonts/B';
    env.VITE_MCP_BRIDGE_URL = 'http://127.0.0.1:8787';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds request from config values', () => {
    const req = buildFontCatalogRequest();
    expect(req.mode).toBe('hybrid');
    expect(req.localRoots).toEqual(['/fonts/a', '/fonts/b']);
    expect(req.nextcloud.baseUrl).toBe('https://cloud.example.com');
    expect(req.nextcloud.paths).toEqual(['/Fonts/A', '/Fonts/B']);
  });

  it('fetches catalog from bridge endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ fonts: [{ id: '1' }], warnings: [] }),
    });
    vi.stubGlobal('fetch', mockFetch as any);
    const data = await fetchFontCatalog();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/fonts/catalog',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(data.fonts).toHaveLength(1);
  });
});

