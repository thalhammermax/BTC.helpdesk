import { SignJWT, jwtVerify } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import type { Role, User } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { HttpError } from '../lib/http.js';
import { verifyAccessToken, type EntraIdentity } from './entra.js';

const key = new TextEncoder().encode(config.sessionSecret);
export const SESSION_COOKIE = 'hd_session';
const secure = config.apiUrl.startsWith('https://');

export async function sign(payload: Record<string, unknown>, ttl: string) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).sign(key);
}
export async function verify<T>(token: string): Promise<T> {
  const { payload } = await jwtVerify(token, key);
  return payload as T;
}
export const cookieOpts = (maxAgeMs: number) => ({
  httpOnly: true,
  secure,
  sameSite: 'lax' as const,
  maxAge: maxAgeMs,
  path: '/',
});

export function roleFromIdentity(id: EntraIdentity, current?: Role): Role {
  if (config.entra.bootstrapAdmins.includes(id.email)) return 'ADMIN';
  if (id.roles.includes(config.entra.adminRole)) return 'ADMIN';
  if (id.roles.includes(config.entra.agentRole)) return 'AGENT';
  if (config.entra.rolesAuthoritative) return 'REQUESTER';
  return current ?? 'REQUESTER';
}

/** Create or update the local user that corresponds to an Entra identity. */
export async function upsertUser(id: EntraIdentity, touchLogin = true): Promise<User> {
  const existing =
    (await prisma.user.findUnique({ where: { entraOid: id.oid } })) ??
    (await prisma.user.findUnique({ where: { email: id.email } }));
  const role = roleFromIdentity(id, existing?.role);
  const data = { email: id.email, name: id.name, entraOid: id.oid, role, ...(touchLogin ? { lastLoginAt: new Date() } : {}) };
  return existing
    ? prisma.user.update({ where: { id: existing.id }, data })
    : prisma.user.create({ data });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

// Short cache so every extension request doesn't hit the DB for upsert.
const bearerCache = new Map<string, { userId: string; exp: number }>();

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const cached = bearerCache.get(token);
      if (cached && cached.exp > Date.now()) {
        req.user = (await prisma.user.findUnique({ where: { id: cached.userId } })) ?? undefined;
      } else {
        const identity = await verifyAccessToken(token);
        req.user = await upsertUser(identity, false);
        bearerCache.set(token, { userId: req.user.id, exp: Date.now() + 5 * 60_000 });
        if (bearerCache.size > 5000) bearerCache.clear();
      }
    } else if (req.cookies?.[SESSION_COOKIE]) {
      const { uid } = await verify<{ uid: string }>(req.cookies[SESSION_COOKIE]);
      req.user = (await prisma.user.findUnique({ where: { id: uid } })) ?? undefined;
    }
  } catch {
    req.user = undefined;
  }
  if (req.user && !req.user.active) req.user = undefined;
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  next();
}
const rank: Record<Role, number> = { REQUESTER: 0, AGENT: 1, ADMIN: 2 };
export const isAgent = (u?: User) => !!u && rank[u.role] >= rank.AGENT;
export const requireRole = (role: Role) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  if (rank[req.user.role] < rank[role]) return next(new HttpError(403, 'Insufficient role'));
  next();
};
