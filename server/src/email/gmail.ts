/**
 * Google Workspace / Gmail connector (Gmail API).
 *
 * Auth modes:
 *  - service_account: a Google Cloud service account with domain-wide delegation impersonates the
 *    help desk mailbox (scope https://www.googleapis.com/auth/gmail.modify).
 *  - oauth: an OAuth refresh token issued by the help desk mailbox itself (access limited to that mailbox).
 *    Generate one with `npm run gmail:authorize`.
 *
 * Inbound: imports Inbox messages that don't yet carry the processed label, then labels them
 * (and archives them if GMAIL_ARCHIVE=true). Failed messages stay unlabeled and are retried.
 * Outbound: sends raw MIME through users.messages.send from the help desk mailbox.
 */
import fs from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import { config } from '../config.js';
import { processRawEmail } from './inbound.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function loadServiceAccount(): ServiceAccountKey {
  const g = config.mail.gmail;
  const raw = g.serviceAccountJson
    ? g.serviceAccountJson.trim().startsWith('{')
      ? g.serviceAccountJson
      : Buffer.from(g.serviceAccountJson, 'base64').toString('utf8')
    : g.serviceAccountKeyFile
      ? fs.readFileSync(g.serviceAccountKeyFile, 'utf8')
      : '';
  if (!raw) throw new Error('Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_JSON');
  return JSON.parse(raw) as ServiceAccountKey;
}

/** Build the signed JWT assertion for the service-account (domain-wide delegation) flow. */
export async function serviceAccountAssertion(key: ServiceAccountKey, subject: string, now = Math.floor(Date.now() / 1000)) {
  const pk = await importPKCS8(key.private_key, 'RS256');
  return new SignJWT({ scope: GMAIL_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(key.client_email)
    .setSubject(subject)
    .setAudience(key.token_uri ?? TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(pk);
}

let cached: { token: string; exp: number } | undefined;
export function resetGmailToken() {
  cached = undefined;
}

export async function gmailToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const g = config.mail.gmail;
  let body: URLSearchParams;
  if (g.auth === 'oauth') {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: g.oauthClientId,
      client_secret: g.oauthClientSecret,
      refresh_token: g.oauthRefreshToken,
    });
  } else {
    const key = loadServiceAccount();
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await serviceAccountAssertion(key, config.mail.address),
    });
  }
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token)
    throw new Error(`Google token request failed: ${json.error_description ?? json.error ?? res.status}` +
      (json.error === 'unauthorized_client' ? ' (check domain-wide delegation client ID and scope in the Admin console)' : ''));
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function gmail<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await gmailToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Gmail ${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

let labelId: string | undefined;
async function processedLabelId(): Promise<string> {
  if (labelId) return labelId;
  const name = config.mail.gmail.processedLabel;
  const { labels = [] } = await gmail<{ labels?: { id: string; name: string }[] }>('/labels');
  const found = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (found) return (labelId = found.id);
  // nested labels ("Helpdesk/Processed") need their parent to exist first
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (!labels.some((l) => l.name.toLowerCase() === parent.toLowerCase()))
      await gmail('/labels', { method: 'POST', body: JSON.stringify({ name: parent }) }).catch(() => undefined);
  }
  const created = await gmail<{ id: string }>('/labels', {
    method: 'POST',
    body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  });
  return (labelId = created.id);
}

export function inboxQuery() {
  const label = config.mail.gmail.processedLabel.replace(/"/g, '');
  return ['in:inbox', `-label:"${label}"`, config.mail.gmail.query].filter(Boolean).join(' ');
}

/** Import new messages from the help desk Gmail inbox. */
export async function pollGmail(): Promise<number> {
  const label = await processedLabelId();
  const list = await gmail<{ messages?: { id: string }[] }>(`/messages?maxResults=25&q=${encodeURIComponent(inboxQuery())}`);
  // Gmail lists newest first; process oldest first so replies land after their originals
  const ids = (list.messages ?? []).map((m) => m.id).reverse();
  let n = 0;
  for (const id of ids) {
    try {
      const msg = await gmail<{ raw: string }>(`/messages/${id}?format=raw`);
      const r = await processRawEmail(Buffer.from(msg.raw, 'base64url'), `gmail:${id}`);
      console.log(`[mail] gmail ${id} → ${r.status}${r.ticketId ? ` #${r.ticketId}` : ''}${r.reason ? ` (${r.reason})` : ''}`);
      n++;
    } catch (e) {
      console.error('[mail] failed to process gmail message', id, (e as Error).message);
      continue; // not labeled → retried next poll
    }
    await gmail(`/messages/${id}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: [label], removeLabelIds: ['UNREAD', ...(config.mail.gmail.archive ? ['INBOX'] : [])] }),
    });
  }
  return n;
}

/**
 * Send a raw MIME message from the help desk mailbox. Returns the Message-ID header Gmail actually
 * used, so replies can be threaded back to the ticket even if Gmail rewrote it.
 */
export async function sendGmail(mime: Buffer, fallbackMessageId: string): Promise<string> {
  const sent = await gmail<{ id: string }>('/messages/send', { method: 'POST', body: JSON.stringify({ raw: mime.toString('base64url') }) });
  try {
    const meta = await gmail<{ payload?: { headers?: { name: string; value: string }[] } }>(
      `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`,
    );
    return meta.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value ?? fallbackMessageId;
  } catch {
    return fallbackMessageId;
  }
}
