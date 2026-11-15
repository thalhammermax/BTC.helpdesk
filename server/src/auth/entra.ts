import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config, entraAuthority } from '../config.js';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
const getJwks = () =>
  (jwks ??= createRemoteJWKSet(new URL(`${entraAuthority()}/discovery/v2.0/keys`)));

export const entraIssuer = () => `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`;

export interface EntraIdentity {
  oid: string;
  email: string;
  name: string;
  roles: string[];
}

export function identityFromClaims(c: JWTPayload & Record<string, unknown>): EntraIdentity {
  const email = String(c.preferred_username ?? c.email ?? c.upn ?? '').toLowerCase();
  if (!c.oid || !email) throw new Error('Token is missing oid or email claims');
  return {
    oid: String(c.oid),
    email,
    name: String(c.name ?? email),
    roles: Array.isArray(c.roles) ? (c.roles as string[]) : [],
  };
}

const b64url = (b: Buffer) => b.toString('base64url');
export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
export const randomToken = () => b64url(crypto.randomBytes(24));

export const redirectUri = () => `${config.apiUrl}/auth/callback`;

export function authorizeUrl(p: { state: string; nonce: string; challenge: string; loginHint?: string }) {
  const u = new URL(`${entraAuthority()}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: config.entra.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: 'openid profile email offline_access',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  }).toString();
  return u.toString();
}

/** Exchange an authorization code for tokens and return the verified identity. */
export async function redeemCode(code: string, verifier: string, nonce: string): Promise<EntraIdentity> {
  const res = await fetch(`${entraAuthority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.entra.clientId,
      client_secret: config.entra.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  const body = (await res.json()) as { id_token?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new Error(body.error_description ?? 'Token exchange failed');
  const { payload } = await jwtVerify(body.id_token, getJwks(), {
    issuer: entraIssuer(),
    audience: config.entra.clientId,
  });
  if (payload.nonce !== nonce) throw new Error('Nonce mismatch');
  return identityFromClaims(payload);
}

/**
 * Verify an Entra access token issued for this API (used by the Chrome extension).
 * The app registration must set "accessTokenAcceptedVersion": 2 so tokens use the v2 issuer.
 */
export async function verifyAccessToken(token: string): Promise<EntraIdentity> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: entraIssuer(),
    audience: [config.entra.clientId, `api://${config.entra.clientId}`],
  });
  const scp = String(payload.scp ?? '');
  if (!scp.split(' ').includes('access_as_user')) throw new Error('Token lacks access_as_user scope');
  return identityFromClaims(payload);
}

/** Client-credentials token for Microsoft Graph (used for the support mailbox). */
let graphToken: { token: string; exp: number } | undefined;
export async function graphAppToken(): Promise<string> {
  if (graphToken && graphToken.exp > Date.now() + 60_000) return graphToken.token;
  const res = await fetch(`${entraAuthority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.entra.clientId,
      client_secret: config.entra.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Graph token failed: ${body.error_description}`);
  graphToken = { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return graphToken.token;
}
