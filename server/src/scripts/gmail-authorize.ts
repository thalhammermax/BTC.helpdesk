/**
 * One-time helper for GMAIL_AUTH=oauth: sign in as the help desk mailbox and print a refresh token.
 *
 *   GMAIL_OAUTH_CLIENT_ID=... GMAIL_OAUTH_CLIENT_SECRET=... MAIL_ADDRESS=helpdesk@example.com npm run gmail:authorize
 *
 * Uses an OAuth client of type "Desktop app" with a loopback redirect, so run it on your own computer.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { GMAIL_SCOPE } from '../email/gmail.js';

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET first.');
  process.exit(1);
}
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('base64url');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  try {
    if (url.searchParams.get('state') !== state) throw new Error('State mismatch');
    if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error')!);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: url.searchParams.get('code')!,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
    });
    const tok = (await r.json()) as { refresh_token?: string; error_description?: string };
    if (!tok.refresh_token) throw new Error(tok.error_description ?? 'No refresh token returned');
    res.end('Done. You can close this tab and return to the terminal.');
    console.log(`\nAdd this to your .env:\n\nGMAIL_AUTH=oauth\nGMAIL_OAUTH_REFRESH_TOKEN=${tok.refresh_token}\n`);
  } catch (e) {
    res.end(`Failed: ${(e as Error).message}`);
    console.error((e as Error).message);
  }
  server.close();
});

server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as AddressInfo).port;
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(process.env.MAIL_ADDRESS ? { login_hint: process.env.MAIL_ADDRESS } : {}),
  }).toString();
  console.log(`Open this URL and sign in AS THE HELP DESK MAILBOX (${process.env.MAIL_ADDRESS ?? 'helpdesk@…'}):\n\n${u}\n`);
});
