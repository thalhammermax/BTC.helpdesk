import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { prisma } from './db.js';
import { authenticate, requireUser, isAgent } from './auth/session.js';
import { authRouter } from './routes/auth.js';
import { attachmentsRouter, ticketsRouter } from './routes/tickets.js';
import { cannedRouter, categoriesRouter, mailLogRouter, rulesRouter, settingsRouter, statsRouter, teamsRouter, usersRouter } from './routes/admin.js';
import { errorHandler } from './lib/http.js';
import { startMailPoller, pollOnce } from './email/poller.js';
import { processRawEmail } from './email/inbound.js';
import { autoCloseResolved } from './services/tickets.js';
import { getSetting } from './services/settings.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // The Chrome extension calls the API cross-origin with Entra bearer tokens (no cookies).
  app.use(
    '/api',
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, false);
        const ok = origin.startsWith('chrome-extension://') && (!config.extensionOrigins.length || config.extensionOrigins.includes(origin.toLowerCase()));
        cb(null, ok);
      },
      credentials: false,
      allowedHeaders: ['Authorization', 'Content-Type'],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '15mb' })); // screenshots from the extension arrive as data URLs

  app.get('/healthz', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });

  // Optional: accept raw MIME from a mail relay (e.g. a transport rule / mail provider webhook)
  app.post('/inbound/email', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
    const secret = process.env.INBOUND_WEBHOOK_SECRET;
    if (!secret || req.query.secret !== secret) return res.status(401).end();
    const id = String(req.headers['x-message-id'] ?? `webhook:${Date.now()}:${Math.random()}`);
    res.json(await processRawEmail(req.body as Buffer, id));
  });

  app.use(authenticate);
  app.use('/auth', express.urlencoded({ extended: false }), authRouter);

  const api = express.Router();
  api.use(requireUser);
  api.get('/me', async (req, res) => {
    const u = req.user!;
    res.json({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      available: u.available,
      isAgent: isAgent(u),
      helpdeskName: await getSetting('helpdeskName'),
    });
  });
  api.patch('/me', async (req, res) => {
    const available = req.body?.available;
    if (typeof available !== 'boolean') return res.status(400).json({ error: 'available must be boolean' });
    const u = await prisma.user.update({ where: { id: req.user!.id }, data: { available } });
    res.json({ available: u.available });
  });
  api.use('/tickets', ticketsRouter);
  api.use('/attachments', attachmentsRouter);
  api.use('/users', usersRouter);
  api.use('/teams', teamsRouter);
  api.use('/categories', categoriesRouter);
  api.use('/rules', rulesRouter);
  api.use('/canned', cannedRouter);
  api.use('/settings', settingsRouter);
  api.use('/stats', statsRouter);
  api.use('/mail-log', mailLogRouter);
  api.post('/mail/poll', async (req, res) => {
    if (req.user!.role !== 'ADMIN') return res.status(403).end();
    await pollOnce();
    res.json({ ok: true });
  });
  app.use('/api', api);

  // Serve the built web app (single-page app) in production.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = createApp();
  app.listen(config.port, () => console.log(`Help desk API listening on :${config.port}`));
  startMailPoller();
  setInterval(() => autoCloseResolved().catch((e) => console.error('[auto-close]', e)), 3600_000).unref();
}
