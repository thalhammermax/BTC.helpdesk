// Microsoft Entra sign-in for the extension: authorization code + PKCE via chrome.identity.
// The extension's redirect URI (https://<extension-id>.chromiumapp.org/) must be registered
// as a "Single-page application" redirect URI on the Entra app registration.
import { getConfig } from './config.js';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function tokenRequest(cfg, params) {
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, scope: `${cfg.scope} offline_access openid profile`, ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || 'Token request failed');
  const tokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in - 120) * 1000,
  };
  await chrome.storage.local.set({ tokens });
  return tokens;
}

async function loginHint() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return info.email || undefined;
  } catch {
    return undefined;
  }
}

/** Run the interactive (or silent) authorization code flow. */
export async function signIn({ interactive = true } = {}) {
  const cfg = await getConfig();
  if (!cfg.complete) throw new Error('The extension is not configured. Ask your administrator, or open the extension options.');
  const verifier = rand(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = rand(16);
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize`);
  const hint = await loginHint();
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: `${cfg.scope} offline_access openid profile`,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(interactive ? { prompt: 'select_account' } : { prompt: 'none' }),
    ...(hint ? { login_hint: hint } : {}),
  }).toString();

  const result = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive,
    // a silent attempt must not hang when Entra needs user interaction
    abortOnLoadForNonInteractive: false,
    timeoutMsForNonInteractive: 8000,
  });
  if (!result) throw new Error('Sign-in was cancelled');
  const params = new URL(result).searchParams;
  if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));
  if (params.get('state') !== state) throw new Error('Sign-in state mismatch');
  return tokenRequest(cfg, { grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri, code_verifier: verifier });
}

/** Returns a valid access token, refreshing silently when possible. Returns null if the user must sign in. */
export async function getAccessToken({ allowSilentFlow = true } = {}) {
  const { tokens } = await chrome.storage.local.get('tokens');
  if (tokens?.accessToken && tokens.expiresAt > Date.now()) return tokens.accessToken;
  const cfg = await getConfig();
  if (!cfg.complete) return null;
  if (tokens?.refreshToken) {
    try {
      return (await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken })).accessToken;
    } catch {
      /* fall through to silent sign-in */
    }
  }
  if (!allowSilentFlow) return null;
  try {
    return (await signIn({ interactive: false })).accessToken;
  } catch {
    return null;
  }
}

export async function signOut() {
  await chrome.storage.local.remove(['tokens', 'me', 'seen']);
}

/** Call the help desk API with the user's token. */
export async function api(path, { method, json } = {}) {
  const cfg = await getConfig();
  const token = await getAccessToken();
  if (!token) {
    const e = new Error('Not signed in');
    e.status = 401;
    throw e;
  }
  const res = await fetch(`${cfg.apiUrl}/api${path}`, {
    method: method || (json ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) await chrome.storage.local.remove('tokens');
  if (!res.ok) {
    const e = new Error(body.error || res.statusText);
    e.status = res.status;
    throw e;
  }
  return body;
}
