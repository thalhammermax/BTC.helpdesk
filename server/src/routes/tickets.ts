import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Prisma, User } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { isAgent, requireRole } from '../auth/session.js';
import { forbidden, HttpError, notFound } from '../lib/http.js';
import { openStream } from '../lib/storage.js';
import { addMessage, createTicket, findOrCreateUserByEmail, logEvent, updateTicket, type IncomingFile } from '../services/tickets.js';
import { OPEN_STATUSES } from '../services/assignment.js';

export const ticketsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } });

const STATUS = z.enum(['NEW', 'OPEN', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED']);
const PRIORITY = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const userSelect = { id: true, name: true, email: true, role: true } as const;

const filesOf = (req: Request): IncomingFile[] =>
  ((req.files as Express.Multer.File[]) ?? []).map((f) => ({ filename: f.originalname, contentType: f.mimetype, data: f.buffer }));

/** Data URL screenshots (from the Chrome extension) become attachments. */
function dataUrlFile(dataUrl: unknown, name: string): IncomingFile | undefined {
  if (typeof dataUrl !== 'string') return undefined;
  const m = /^data:(image\/(png|jpeg));base64,(.+)$/.exec(dataUrl);
  if (!m) return undefined;
  return { filename: `${name}.${m[2] === 'jpeg' ? 'jpg' : 'png'}`, contentType: m[1], data: Buffer.from(m[3], 'base64') };
}

async function loadTicketFor(user: User, id: number) {
  const t = await prisma.ticket.findUnique({ where: { id }, include: { watchers: true } });
  if (!t) throw notFound('Ticket not found');
  if (!isAgent(user) && t.requesterId !== user.id && !t.watchers.some((w) => w.userId === user.id)) throw notFound('Ticket not found');
  return t;
}

ticketsRouter.get('/', async (req, res) => {
  const user = req.user!;
  const q = z
    .object({
      view: z.enum(['all', 'mine', 'unassigned', 'myteams', 'requested', 'overdue']).default(isAgent(user) ? 'mine' : 'requested'),
      status: z.string().optional(),
      priority: z.string().optional(),
      assigneeId: z.string().optional(),
      teamId: z.string().optional(),
      categoryId: z.string().optional(),
      requesterId: z.string().optional(),
      q: z.string().optional(),
      sort: z.enum(['updatedAt', 'createdAt', 'priority', 'resolutionDue', 'id']).default('updatedAt'),
      order: z.enum(['asc', 'desc']).default('desc'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    })
    .parse(req.query);

  const and: Prisma.TicketWhereInput[] = [];
  if (!isAgent(user) || q.view === 'requested') and.push({ OR: [{ requesterId: user.id }, { watchers: { some: { userId: user.id } } }] });
  if (isAgent(user)) {
    if (q.view === 'mine') and.push({ assigneeId: user.id });
    if (q.view === 'unassigned') and.push({ assigneeId: null });
    if (q.view === 'myteams') and.push({ team: { members: { some: { userId: user.id } } } });
    if (q.view === 'overdue') and.push({ resolutionDue: { lt: new Date() }, status: { in: [...OPEN_STATUSES] } });
    if (q.assigneeId) and.push({ assigneeId: q.assigneeId === 'none' ? null : q.assigneeId });
    if (q.teamId) and.push({ teamId: q.teamId });
    if (q.categoryId) and.push({ categoryId: q.categoryId });
    if (q.requesterId) and.push({ requesterId: q.requesterId });
  }
  if (q.status) and.push({ status: { in: q.status.split(',').map((s) => STATUS.parse(s)) } });
  else if (['mine', 'unassigned', 'myteams'].includes(q.view)) and.push({ status: { in: [...OPEN_STATUSES] } });
  if (q.priority) and.push({ priority: { in: q.priority.split(',').map((s) => PRIORITY.parse(s)) } });
  if (q.q) {
    const term = q.q.trim();
    const num = Number(term.replace(/^#/, ''));
    and.push({
      OR: [
        ...(Number.isInteger(num) && num > 0 ? [{ id: num }] : []),
        { subject: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { requester: { email: { contains: term, mode: 'insensitive' } } },
        { requester: { name: { contains: term, mode: 'insensitive' } } },
        { tags: { has: term.toLowerCase() } },
      ],
    });
  }
  const where: Prisma.TicketWhereInput = { AND: and };
  const [items, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: { [q.sort]: q.order },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        requester: { select: userSelect },
        assignee: { select: userSelect },
        team: { select: { id: true, name: true } },
        category: true,
        _count: { select: { messages: true } },
      },
    }),
    prisma.ticket.count({ where }),
  ]);
  res.json({ items, total, page: q.page, pageSize: q.pageSize });
});

const createSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1),
  priority: PRIORITY.optional(),
  categoryId: z.string().optional().nullable(),
  sourceUrl: z.string().url().optional().or(z.literal('')),
  // staff only
  requesterEmail: z.string().email().optional().or(z.literal('')),
  assigneeId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  cc: z.union([z.array(z.string().email()), z.string()]).optional(),
  screenshot: z.string().optional(),
});
const toList = (v?: string | string[]) => (Array.isArray(v) ? v : v ? v.split(',') : []).map((s) => s.trim()).filter(Boolean);

ticketsRouter.post('/', upload.array('files'), async (req, res) => {
  const user = req.user!;
  const body = createSchema.parse(req.body);
  const staff = isAgent(user);
  const requester = staff && body.requesterEmail ? await findOrCreateUserByEmail(body.requesterEmail) : user;
  const files = filesOf(req);
  const shot = dataUrlFile(body.screenshot, 'screenshot');
  if (shot) files.push(shot);
  const channel = req.headers.authorization?.startsWith('Bearer ') ? 'EXTENSION' : 'WEB';
  const ticket = await createTicket({
    subject: body.subject,
    description: body.description,
    priority: body.priority,
    categoryId: body.categoryId || undefined,
    sourceUrl: body.sourceUrl || undefined,
    requester,
    channel,
    assigneeId: staff ? body.assigneeId || undefined : undefined,
    teamId: staff ? body.teamId || undefined : undefined,
    tags: staff ? toList(body.tags).map((t) => t.toLowerCase()) : [],
    ccEmails: toList(body.cc),
    files,
    actor: user,
  });
  res.status(201).json(ticket);
});

ticketsRouter.get('/:id', async (req, res) => {
  const user = req.user!;
  const id = Number(req.params.id);
  await loadTicketFor(user, id);
  const staff = isAgent(user);
  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: {
      requester: { select: userSelect },
      assignee: { select: userSelect },
      team: { select: { id: true, name: true } },
      category: true,
      watchers: { include: { user: { select: userSelect } } },
      messages: {
        where: staff ? {} : { internal: false },
        orderBy: { createdAt: 'asc' },
        include: { author: { select: userSelect }, attachments: true },
      },
      events: staff ? { orderBy: { createdAt: 'asc' }, include: { actor: { select: userSelect } } } : false,
    },
  });
  res.json(ticket);
});

const patchSchema = z.object({
  subject: z.string().trim().min(1).max(500).optional(),
  status: STATUS.optional(),
  priority: PRIORITY.optional(),
  assigneeId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().toLowerCase()).optional(),
});

ticketsRouter.patch('/:id', requireRole('AGENT'), async (req, res) => {
  res.json(await updateTicket(Number(req.params.id), req.user!, patchSchema.parse(req.body)));
});

ticketsRouter.post('/bulk', requireRole('AGENT'), async (req, res) => {
  const { ids, patch } = z.object({ ids: z.array(z.number().int()).min(1).max(500), patch: patchSchema }).parse(req.body);
  for (const id of ids) await updateTicket(id, req.user!, patch);
  res.json({ updated: ids.length });
});

// Requesters may close or reopen their own tickets
ticketsRouter.post('/:id/status', async (req, res) => {
  const user = req.user!;
  const t = await loadTicketFor(user, Number(req.params.id));
  const { status } = z.object({ status: z.enum(['RESOLVED', 'OPEN']) }).parse(req.body);
  if (!isAgent(user) && t.requesterId !== user.id) throw forbidden();
  res.json(await updateTicket(t.id, user, { status }));
});

ticketsRouter.post('/:id/messages', upload.array('files'), async (req, res) => {
  const user = req.user!;
  const t = await loadTicketFor(user, Number(req.params.id));
  const body = z
    .object({
      body: z.string().trim().min(1),
      internal: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
      status: STATUS.optional(),
    })
    .parse(req.body);
  const msg = await addMessage({
    ticketId: t.id,
    author: user,
    body: body.body,
    internal: body.internal,
    status: isAgent(user) ? body.status : undefined,
    channel: req.headers.authorization?.startsWith('Bearer ') ? 'EXTENSION' : 'WEB',
    files: filesOf(req),
  });
  res.status(201).json(msg);
});

ticketsRouter.post('/:id/watchers', async (req, res) => {
  const user = req.user!;
  const t = await loadTicketFor(user, Number(req.params.id));
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const w = await findOrCreateUserByEmail(email);
  await prisma.ticketWatcher.upsert({ where: { ticketId_userId: { ticketId: t.id, userId: w.id } }, update: {}, create: { ticketId: t.id, userId: w.id } });
  await logEvent(t.id, user.id, 'watcher_added', { email });
  res.status(201).json({ ok: true });
});

ticketsRouter.delete('/:id/watchers/:userId', async (req, res) => {
  const user = req.user!;
  const t = await loadTicketFor(user, Number(req.params.id));
  if (!isAgent(user) && String(req.params.userId) !== user.id) throw forbidden();
  await prisma.ticketWatcher.deleteMany({ where: { ticketId: t.id, userId: String(req.params.userId) } });
  res.json({ ok: true });
});

/** Merge this ticket into another: conversation moves to the target, source is closed. */
ticketsRouter.post('/:id/merge', requireRole('AGENT'), async (req, res) => {
  const sourceId = Number(req.params.id);
  const { intoId } = z.object({ intoId: z.number().int() }).parse(req.body);
  if (sourceId === intoId) throw new HttpError(400, 'Cannot merge a ticket into itself');
  const [src, dst] = await Promise.all([prisma.ticket.findUnique({ where: { id: sourceId } }), prisma.ticket.findUnique({ where: { id: intoId } })]);
  if (!src || !dst) throw notFound('Ticket not found');
  await prisma.$transaction([
    prisma.message.updateMany({ where: { ticketId: sourceId }, data: { ticketId: intoId } }),
    prisma.attachment.updateMany({ where: { ticketId: sourceId }, data: { ticketId: intoId } }),
    prisma.message.create({ data: { ticketId: intoId, authorId: req.user!.id, internal: true, body: `Ticket #${sourceId} "${src.subject}" was merged into this ticket.` } }),
    prisma.message.create({ data: { ticketId: sourceId, authorId: req.user!.id, internal: true, body: `Merged into ticket #${intoId}.` } }),
    prisma.ticket.update({ where: { id: sourceId }, data: { status: 'CLOSED', closedAt: new Date() } }),
  ]);
  if (src.requesterId !== dst.requesterId)
    await prisma.ticketWatcher.upsert({ where: { ticketId_userId: { ticketId: intoId, userId: src.requesterId } }, update: {}, create: { ticketId: intoId, userId: src.requesterId } });
  await logEvent(sourceId, req.user!.id, 'merged', { into: intoId });
  await logEvent(intoId, req.user!.id, 'merged_from', { from: sourceId });
  res.json({ ok: true });
});

export const attachmentsRouter = Router();
attachmentsRouter.get('/:id', async (req, res) => {
  const a = await prisma.attachment.findUnique({ where: { id: String(req.params.id) }, include: { message: true } });
  if (!a) throw notFound();
  await loadTicketFor(req.user!, a.ticketId);
  if (a.message?.internal && !isAgent(req.user)) throw notFound();
  const inline = /^image\/|^application\/pdf$/.test(a.contentType) && req.query.download !== '1';
  res.setHeader('Content-Type', a.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader('Content-Length', String(a.size));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const stream = await openStream(a.storageKey);
  stream.on('error', (e) => { console.error('[attachments]', e.message); res.destroy(e); });
  stream.pipe(res);
});
