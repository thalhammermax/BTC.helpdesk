import { Router } from 'express';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { authorizeUrl, pkcePair, randomToken, redeemCode } from '../auth/entra.js';
import { SESSION_COOKIE, cookieOpts, sign, upsertUser, verify } from '../auth/session.js';

const FLOW_COOKIE = 'hd_oidc';
const SESSION_TTL_H = 10;
export const authRouter = Router();

const safeReturn = (r: unknown) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') ? r : '/');

authRouter.get('/login', async (req, res) => {
  const { verifier, challenge } = pkcePair();
  const state = randomToken();
  const nonce = randomToken();
  const flow = await sign({ state, nonce, verifier, returnTo: safeReturn(req.query.returnTo) }, '10m');
  res.cookie(FLOW_COOKIE, flow, cookieOpts(10 * 60_000));
  res.redirect(authorizeUrl({ state, nonce, challenge, loginHint: req.query.login_hint as string | undefined }));
});

authRouter.get('/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description ?? req.query.error));
    const flow = await verify<{ state: string; nonce: string; verifier: string; returnTo: string }>(
      req.cookies?.[FLOW_COOKIE] ?? '',
    );
    if (flow.state !== req.query.state) throw new Error('State mismatch');
    const identity = await redeemCode(String(req.query.code), flow.verifier, flow.nonce);
    const user = await upsertUser(identity);
    if (!user.active) throw new Error('Your account has been disabled');
    res.clearCookie(FLOW_COOKIE, { path: '/' });
    res.cookie(SESSION_COOKIE, await sign({ uid: user.id }, `${SESSION_TTL_H}h`), cookieOpts(SESSION_TTL_H * 3600_000));
    res.redirect(`${config.appUrl}${flow.returnTo}`);
  } catch (e) {
    res.redirect(`${config.appUrl}/login?error=${encodeURIComponent((e as Error).message)}`);
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  const logoutUrl = config.entra.tenantId
    ? `https://login.microsoftonline.com/${config.entra.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.appUrl + '/login')}`
    : `${config.appUrl}/login`;
  res.json({ logoutUrl });
});

authRouter.get('/config', (_req, res) => {
  res.json({ devLogin: config.devLogin, entraConfigured: !!config.entra.clientId });
});

// Local development helper: sign in as any email without Entra. Disabled in production.
authRouter.post('/dev-login', async (req, res) => {
  if (!config.devLogin) return res.status(404).end();
  const email = String(req.body?.email ?? '').toLowerCase();
  const role = ['ADMIN', 'AGENT', 'REQUESTER'].includes(req.body?.role) ? req.body.role : 'REQUESTER';
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = await prisma.user.upsert({
    where: { email },
    update: { role, lastLoginAt: new Date() },
    create: { email, name: email.split('@')[0], role, lastLoginAt: new Date() },
  });
  res.cookie(SESSION_COOKIE, await sign({ uid: user.id }, `${SESSION_TTL_H}h`), cookieOpts(SESSION_TTL_H * 3600_000));
  res.json({ ok: true });
});
