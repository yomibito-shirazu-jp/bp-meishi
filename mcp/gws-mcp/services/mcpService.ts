import { supabase, supabaseUrl } from './supabaseClient';

interface GoogleToken {
  access_token: string;
  expires_in: number;
  token_type: string;
  timestamp?: number;
}

let cachedToken: GoogleToken | null = null;

/** hasAuthError 時に get-google-token 呼び出しを抑止（ログ・通信のスパム防止） */
let reauthRequired = false;
export function setReauthRequired(v: boolean) {
  reauthRequired = v;
  if (v) cachedToken = null;
}
export function isReauthRequired(): boolean {
  return reauthRequired;
}

// 1. Fetches a Google access token from the Supabase Edge Function.
//    Caches the token to avoid unnecessary function calls.
//    - セッション取得・refreshSession で有効な JWT を確保してから呼び出す
//    - 明示的に Authorization: Bearer を付与して 401 を防止
async function getGoogleAccessToken(): Promise<string> {
  if (reauthRequired) {
    throw new Error("REAUTHENTICATION_REQUIRED");
  }

  const now = Date.now();
  if (cachedToken && cachedToken.timestamp && (now < cachedToken.timestamp + (cachedToken.expires_in - 60) * 1000)) {
    return cachedToken.access_token;
  }

  // セッション取得（auth 状態が ready であることを前提に呼び元で制御）
  const { data: { session }, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr || !session) {
    throw new Error("REAUTHENTICATION_REQUIRED");
  }

  // access_token の有効期限切れ対策: refreshSession で必ず更新してから呼び出す
  const { data: { session: refreshedSession }, error: refreshErr } = await supabase.auth.refreshSession();
  if (refreshErr) {
    throw new Error("REAUTHENTICATION_REQUIRED");
  }
  const activeSession = refreshedSession ?? session;
  if (!activeSession?.access_token) {
    throw new Error("REAUTHENTICATION_REQUIRED");
  }
  const accessToken = activeSession.access_token;

  const res = await fetch(`${supabaseUrl}/functions/v1/get-google-token`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    cachedToken = null;
    const code = json?.code ?? '';
    console.error('[get-google-token]', res.status, code, json?.error);
    const reauthCodes = ['REAUTHENTICATION_REQUIRED', 'MISSING_REFRESH_TOKEN', 'GOOGLE_TOKEN_EXCHANGE_FAILED', 'NO_AUTH_HEADER', 'INVALID_SESSION'];
    if (reauthCodes.includes(code) || json?.reauthenticate || res.status === 401 || res.status === 409) {
      setReauthRequired(true);
      if (res.status === 409 || code === 'MISSING_REFRESH_TOKEN') {
        window.dispatchEvent(new CustomEvent('gws:reauth-required'));
      }
      throw new Error("REAUTHENTICATION_REQUIRED");
    }
    throw new Error(json?.error ?? `get-google-token failed: ${res.status}`);
  }

  cachedToken = { ...json, timestamp: Date.now() };
  return cachedToken!.access_token;
}

// Helper for making authenticated Google API calls
async function fetchGoogleAPI(url: string) {
    const token = await getGoogleAccessToken();
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });
    if (!res.ok) {
        const errorBody = await res.json();
        console.error("Google API Error:", errorBody);
        // If the token is invalid, clear the cache and throw
        if (res.status === 401) {
            cachedToken = null;
            throw new Error("REAUTHENTICATION_REQUIRED");
        }
        throw new Error(`Google API request failed: ${res.statusText}`);
    }
    return res.json();
}


// 2. Implements the methods to call Google APIs using the fetched token.
export const MCPService = {
  async listCalendarEvents() {
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // Next 24 hours
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;
    return (await fetchGoogleAPI(url)).items;
  },

  async listGmailThreads(query: string) {
    const url = `https://www.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(query)}`;
    return (await fetchGoogleAPI(url)).threads || [];
  },

  async getGmailThread(threadId: string) {
    const url = `https://www.googleapis.com/gmail/v1/users/me/threads/${threadId}`;
    return await fetchGoogleAPI(url);
  },

  async listDriveFiles(query: string) {
    // Drive API の q は Gmail と異なり "name contains 'x'" / "fullText contains 'x'" 形式のみ有効。
    // "label:unread", "is:unread", 生キーワードをそのまま渡すと 400 になるため変換する。
    const driveQ = toDriveSearchQuery(query);
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(driveQ)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)`;
    return (await fetchGoogleAPI(url)).files || [];
  },
};

/**
 * Gmail風・自由文クエリを Drive API で有効な q に変換する。
 * - label:*, is:*, after:* は除去
 * - 残りの語句は fullText contains '...' で AND 結合（シングルクォートはエスケープ）
 * - 有効な語がなければ trashed = false のみ
 */
function toDriveSearchQuery(userQuery: string): string {
  const trimmed = userQuery.trim();
  if (!trimmed) return "trashed = false";

  let cleaned = trimmed
    .replace(/\b(label|is):\s*\S+/gi, " ")
    .replace(/\bafter:\s*[\d-]+\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) return "trashed = false";

  const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const conditions = words.map((w) => `fullText contains '${escape(w)}'`);
  return conditions.join(" and ") + " and trashed = false";
}