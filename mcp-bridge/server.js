import express from 'express';
import cors from 'cors';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const DEFAULT_PORT = Number(process.env.PORT || 8787);
const MAX_SCAN_FILES = Number(process.env.FONT_SCAN_LIMIT || 5000);

const parseCsv = (value = '') =>
  value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

const getAllowedRoots = () => parseCsv(process.env.LOCAL_FONT_ROOTS || '');

const isPathInside = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const toFamilyName = (filename) =>
  path
    .basename(filename, path.extname(filename))
    .replace(/[_-]+/g, ' ')
    .trim();

async function scanLocalFonts(roots) {
  const allowlist = getAllowedRoots();
  const warnings = [];
  const fonts = [];
  const queue = [];

  for (const root of roots) {
    if (!allowlist.length || allowlist.some(allowed => isPathInside(allowed, root) || path.resolve(allowed) === path.resolve(root))) {
      queue.push(path.resolve(root));
    } else {
      warnings.push(`blocked root outside allowlist: ${root}`);
    }
  }

  let scanned = 0;
  while (queue.length && scanned < MAX_SCAN_FILES) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      warnings.push(`cannot read local root: ${current}`);
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!FONT_EXTENSIONS.has(ext)) continue;
      const st = await fs.stat(fullPath);
      fonts.push({
        id: `local:${fullPath}`,
        source: 'local',
        path: fullPath,
        family: toFamilyName(entry.name),
        format: ext.slice(1),
        sizeBytes: st.size,
      });
      scanned += 1;
      if (scanned >= MAX_SCAN_FILES) break;
    }
  }

  return { fonts, warnings };
}

const nextcloudAuthHeader = (username, appPassword) =>
  `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;

const normalizeBaseUrl = (url = '') => url.replace(/\/$/, '');

function parseHrefList(xml) {
  const matches = [...xml.matchAll(/<d:href>(.*?)<\/d:href>/g)];
  return matches.map(m => decodeURIComponent(m[1]));
}

async function listNextcloudFonts(nextcloud) {
  const warnings = [];
  const fonts = [];
  const { baseUrl, username, appPassword, paths = [] } = nextcloud || {};
  if (!baseUrl || !username || !appPassword || !paths.length) {
    return { fonts, warnings: ['nextcloud config incomplete'] };
  }
  const base = normalizeBaseUrl(baseUrl);
  const auth = nextcloudAuthHeader(username, appPassword);

  for (const rawPath of paths) {
    const remotePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const url = `${base}/remote.php/dav/files/${encodeURIComponent(username)}${remotePath}`;
    try {
      const res = await fetch(url, {
        method: 'PROPFIND',
        headers: {
          Authorization: auth,
          Depth: '1',
        },
      });
      if (!res.ok) {
        warnings.push(`nextcloud propfind failed: ${remotePath} (${res.status})`);
        continue;
      }
      const xml = await res.text();
      const hrefs = parseHrefList(xml);
      for (const href of hrefs) {
        const clean = href.split('?')[0];
        const ext = path.extname(clean).toLowerCase();
        if (!FONT_EXTENSIONS.has(ext)) continue;
        fonts.push({
          id: `nextcloud:${clean}`,
          source: 'nextcloud',
          path: clean,
          family: toFamilyName(clean),
          format: ext.slice(1),
        });
      }
    } catch (err) {
      warnings.push(`nextcloud fetch error: ${remotePath} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { fonts, warnings };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bp-meishi-mcp-bridge' });
});

app.post('/fonts/catalog', async (req, res) => {
  const mode = req.body?.mode || 'hybrid';
  const localRoots = Array.isArray(req.body?.localRoots) ? req.body.localRoots : [];
  const nextcloud = req.body?.nextcloud || {};

  const fonts = [];
  const warnings = [];

  if (mode === 'local' || mode === 'hybrid') {
    const result = await scanLocalFonts(localRoots);
    fonts.push(...result.fonts);
    warnings.push(...result.warnings);
  }

  if (mode === 'nextcloud' || mode === 'hybrid') {
    const result = await listNextcloudFonts(nextcloud);
    fonts.push(...result.fonts);
    warnings.push(...result.warnings);
  }

  res.json({ fonts, warnings });
});

app.listen(DEFAULT_PORT, () => {
  console.log(`bp-meishi mcp bridge listening on :${DEFAULT_PORT}`);
});

