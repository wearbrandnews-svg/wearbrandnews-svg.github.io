// Google OAuth：本人のGoogleアカウントでログインし、Drive用のリフレッシュトークンをKVに保管する。
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SCOPES = 'openid email https://www.googleapis.com/auth/drive';
const REFRESH_KEY = 'google:refresh_token';

let cachedToken = null; // { token, expiresAt } — 同じisolate内で再利用

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function googleAuthorizeUrl(env, { redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    login_hint: env.ALLOWED_EMAIL,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(env, body) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...body }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Google token error: ${data.error || response.status} ${data.error_description || ''}`);
  return data;
}

// id_token はGoogleのトークンエンドポイントからTLSで直接受け取ったものなので、署名検証は省略してpayloadを読む
function decodeIdToken(idToken) {
  const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
  return JSON.parse(json);
}

export async function exchangeGoogleCode(env, { code, redirectUri, verifier }) {
  const data = await tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const claims = decodeIdToken(data.id_token);
  const email = String(claims.email || '').toLowerCase();
  const allowed = claims.email_verified === true && email === String(env.ALLOWED_EMAIL).toLowerCase();
  if (allowed) {
    if (data.refresh_token) await env.OAUTH_KV.put(REFRESH_KEY, data.refresh_token);
    cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  }
  return { email, allowed, hasRefreshToken: Boolean(data.refresh_token) };
}

export async function getDriveToken(env, force = false) {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const refreshToken = await env.OAUTH_KV.get(REFRESH_KEY);
  if (!refreshToken) throw new Error('Googleのリフレッシュトークンがありません。コネクタを接続し直してください');
  const data = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}
