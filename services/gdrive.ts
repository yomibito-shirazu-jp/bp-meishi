/**
 * Google Drive Picker — ファイルをGdriveから選択してダウンロード
 *
 * 必要な環境変数:
 *   VITE_GOOGLE_CLIENT_ID  — OAuth 2.0 クライアントID
 *   VITE_GOOGLE_API_KEY    — API Key (Picker API 有効化済み)
 */

import { getConfig } from './config';

const getClientId = () => getConfig('VITE_GOOGLE_CLIENT_ID');
const getApiKey = () => getConfig('VITE_GOOGLE_API_KEY');
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
      client_id: getClientId(),
      scope: SCOPES,
      prompt: 'consent',
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
      error_callback: (err: any) => {
        console.error('GIS token error:', err);
        let errorMsg = err?.message || err?.type || '認証フローでエラーが発生しました。ポップアップブロッカーを確認してください。';
        if (err?.type === 'popup_closed') {
           errorMsg = 'Google認証のポップアップが閉じられました。';
        } else if (err?.message && err.message.includes('origin_mismatch')) {
           errorMsg = 'URLがGoogle Cloud Consoleの「承認済みのJavaScript生成元」に登録されていません。';
        }
        reject(new Error(errorMsg));
      },
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
}

/** MIME types */
const MIME_PDF = 'application/pdf';
const MIME_ALL = 'application/pdf,image/png,image/jpeg,image/gif,image/webp,image/tiff,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,audio/flac';

/** Generic picker — mimeTypes でフィルタ */
async function pickFromDrive(mimeTypes: string, title: string): Promise<File | null> {
  if (!getClientId() || !getApiKey()) {
    throw new Error('Google Drive連携に必要な環境変数が未設定です (VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY)。「設定」から正しく入力してください。');
  }

  try {
    await Promise.all([loadPickerApi(), loadGis()]);
  } catch (err: any) {
    throw new Error('Googleのスクリプト読み込みに失敗しました。広告ブロックが影響している場合があります。');
  }
  
  const token = await getAccessToken();

  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setMimeTypes(mimeTypes)
      .setMode(window.google.picker.DocsViewMode.LIST);

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(getApiKey())
      .setOrigin(window.location.origin)
      .setAppId(getConfig('VITE_GOOGLE_PROJECT_NUMBER') || '270124753853')
      .setTitle(title)
      .setCallback(async (data: any) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data.docs[0];
          try {
            const file = await downloadDriveFile(doc.id, doc.name, doc.mimeType, token);
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

/** 名刺PDF用 Picker */
export async function pickPdfFromDrive(): Promise<File | null> {
  return pickFromDrive(MIME_PDF, 'PDFファイルを選択');
}

/** 文字起こし用 Picker（音声・画像・PDF全対応）*/
export async function pickFileFromDrive(): Promise<File | null> {
  return pickFromDrive(MIME_ALL, 'ファイルを選択（音声・画像・PDF）');
}

/** Download a file from Google Drive by ID */
async function downloadDriveFile(fileId: string, fileName: string, mimeType: string, token: string): Promise<File> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  const blob = await res.blob();
  return new File([blob], fileName || 'file', { type: mimeType || blob.type || 'application/octet-stream' });
}

/** Check if Google Drive integration is configured */
export function isDriveConfigured(): boolean {
  return !!(getClientId() && getApiKey());
}

// Type declarations for Google APIs
declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}
