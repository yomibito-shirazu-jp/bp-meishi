/**
 * Google Drive Picker — PDFファイルをGdriveから選択してダウンロード
 *
 * 必要な環境変数:
 *   VITE_GOOGLE_CLIENT_ID  — OAuth 2.0 クライアントID
 *   VITE_GOOGLE_API_KEY    — API Key (Picker API 有効化済み)
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string;
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

let pickerLoaded = false;
let gisLoaded = false;
let accessToken: string | null = null;
let tokenExpiry = 0;

// Restore token from sessionStorage on load
try {
  const saved = sessionStorage.getItem('gdrive_token');
  const exp = Number(sessionStorage.getItem('gdrive_token_exp') || 0);
  if (saved && exp > Date.now()) {
    accessToken = saved;
    tokenExpiry = exp;
  }
} catch { /* ignore */ }

/** Load Google Picker API script */
function loadPickerApi(): Promise<void> {
  if (pickerLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      window.gapi.load('picker', () => {
        pickerLoaded = true;
        resolve();
      });
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/** Load Google Identity Services script */
function loadGis(): Promise<void> {
  if (gisLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => { gisLoaded = true; resolve(); };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/** Get OAuth access token via Google Identity Services */
function getAccessToken(): Promise<string> {
  if (accessToken && tokenExpiry > Date.now()) return Promise.resolve(accessToken);
  // Clear stale token
  accessToken = null;
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp: any) => {
        if (resp.error) {
          reject(new Error(resp.error));
          return;
        }
        accessToken = resp.access_token;
        // GIS tokens typically last 3600s; store with 5min buffer
        const expiresIn = (resp.expires_in || 3600) * 1000 - 300_000;
        tokenExpiry = Date.now() + expiresIn;
        try {
          sessionStorage.setItem('gdrive_token', resp.access_token);
          sessionStorage.setItem('gdrive_token_exp', String(tokenExpiry));
        } catch { /* ignore */ }
        resolve(resp.access_token);
      },
    });
    client.requestAccessToken();
  });
}

/** Open Google Drive Picker and return selected file as File object */
export async function pickPdfFromDrive(): Promise<File | null> {
  if (!CLIENT_ID || !API_KEY) {
    throw new Error('Google Drive連携に必要な環境変数が未設定です (VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY)');
  }

  await Promise.all([loadPickerApi(), loadGis()]);
  const token = await getAccessToken();

  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setMimeTypes('application/pdf')
      .setMode(window.google.picker.DocsViewMode.LIST);

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setTitle('名刺PDFを選択')
      .setCallback(async (data: any) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data.docs[0];
          try {
            const file = await downloadDriveFile(doc.id, doc.name, token);
            resolve(file);
          } catch (e) {
            console.error('Drive download failed:', e);
            resolve(null);
          }
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();

    picker.setVisible(true);
  });
}

/** Download a file from Google Drive by ID */
async function downloadDriveFile(fileId: string, fileName: string, token: string): Promise<File> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  const blob = await res.blob();
  return new File([blob], fileName || 'drive.pdf', { type: 'application/pdf' });
}

/** Check if Google Drive integration is configured */
export function isDriveConfigured(): boolean {
  return !!(CLIENT_ID && API_KEY);
}

// Type declarations for Google APIs
declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}
