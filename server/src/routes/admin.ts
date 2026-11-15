import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireRole } from '../auth/session.js';
import { HttpError } from '../lib/http.js';
import { runRules } from '../services/rules.js';
import { getSettings, saveSettings } from '../services/settings.js';
import { OPEN_STATUSES } from '../services/assignment.js';

const ROLE = z.enum(['REQUESTER', 'AGENT', 'ADMIN']);
const PRIORITY = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const userSelect = { id: true, name: true, email: true, role: true, active: true, available: true, lastLoginAt: true } as const;

// ---------- Users ----------
export const usersRouter = Router();
usersRouter.get('/', requireRole('AGENT'), async (req, res) => {
  const { q, role } = z.object({ q: z.string().optional(), role: z.string().optional() }).parse(req.query);
  const roles = role ? role.split(',').map((r) => ROLE.parse(r)) : undefined;
  res.json(
    await prisma.user.findMany({
      where: {
        ...(roles ? { role: { in: roles } } : {}),
        ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      select: { ...userSelect, teams: { select: { teamId: true } } },
      orderBy: { name: 'asc' },
      take: 200,
    }),
  );
});
usersRouter.patch('/:id', requireRole('ADMIN'), async (req, res) => {
  const body = z.object({ role: ROLE.optional(), active: z.boolean().optional(), available: z.boolean().optional(), name: z.string().optional() }).parse(req.body);
  if (body.role && config.entra.rolesAuthoritative)
    throw new HttpError(400, 'Roles are managed in Microsoft Entra (app roles). Set ENTRA_ROLES_AUTHORITATIVE=false to manage them here.');
  res.json(await prisma.user.update({ where: { id: String(req.params.id) }, data: body, select: userSelect }));
});

// ---------- Teams ----------
export const teamsRouter = Router();
const teamSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  strategy: z.enum(['NONE', 'ROUND_ROBIN', 'LEAST_LOADED']).default('ROUND_ROBIN'),
  memberIds: z.array(z.string()).default([]),
});
teamsRouter.get('/', requireRole('AGENT'), async (_req, res) => {
  const teams = await prisma.team.findMany({
    orderBy: { name: 'asc' },
    include: { members: { include: { user: { select: userSelect } } }, _count: { select: { tickets: { where: { status: { in: [...OPEN_STATUSES] } } } } } },
  });
  res.json(teams);
});
teamsRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const { memberIds, ...data } = teamSchema.parse(req.body);
  res.status(201).json(
    await prisma.team.create({ data: { ...data, email: data.email || null, members: { create: memberIds.map((userId) => ({ userId })) } } }),
  );
});
teamsRouter.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const { memberIds, ...data } = teamSchema.parse(req.body);
  const id = String(req.params.id);
  await prisma.$transaction([
    prisma.team.update({ where: { id }, data: { ...data, email: data.email || null } }),
    prisma.teamMember.deleteMany({ where: { teamId: id } }),
    prisma.teamMember.createMany({ data: memberIds.map((userId) => ({ teamId: id, userId })) }),
  ]);
  res.json({ ok: true });
});
teamsRouter.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  await prisma.ticket.updateMany({ where: { teamId: String(req.params.id) }, data: { teamId: null } });
  await prisma.team.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

// ---------- Categories ----------
export const categoriesRouter = Router();
categoriesRouter.get('/', async (_req, res) => res.json(await prisma.category.findMany({ orderBy: { name: 'asc' } })));
categoriesRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(1) }).parse(req.body);
  res.status(201).json(await prisma.category.create({ data: { name } }));
});
categoriesRouter.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(1) }).parse(req.body);
  res.json(await prisma.category.update({ where: { id: String(req.params.id) }, data: { name } }));
});
categoriesRouter.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  await prisma.ticket.updateMany({ where: { categoryId: String(req.params.id) }, data: { categoryId: null } });
  await prisma.category.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

// ---------- Auto-assignment rules ----------
export const rulesRouter = Router();
rulesRouter.use(requireRole('ADMIN'));
const ruleSchema = z.object({
  name: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  matchField: z.enum(['SUBJECT', 'DESCRIPTION', 'BOTH']).default('BOTH'),
  matchMode: z.enum(['ANY', 'ALL']).default('ANY'),
  keywords: z.array(z.string().trim()).transform((k) => k.filter(Boolean)).pipe(z.array(z.string()).min(1, 'At least one keyword is required')),
  excludeKeywords: z.array(z.string().trim()).default([]).transform((k) => k.filter(Boolean)),
  wholeWord: z.boolean().default(true),
  assignTeamId: z.string().nullable().optional(),
  assignAgentId: z.string().nullable().optional(),
  setPriority: PRIORITY.nullable().optional(),
  setCategoryId: z.string().nullable().optional(),
  addTags: z.array(z.string().trim().toLowerCase()).default([]),
  stopProcessing: z.boolean().default(true),
});
const ruleInclude = { team: { select: { id: true, name: true } }, agent: { select: { id: true, name: true } }, category: true };
rulesRouter.get('/', async (_req, res) => res.json(await prisma.assignmentRule.findMany({ orderBy: { position: 'asc' }, include: ruleInclude })));
rulesRouter.post('/', async (req, res) => {
  const data = ruleSchema.parse(req.body);
  const last = await prisma.assignmentRule.aggregate({ _max: { position: true } });
  res.status(201).json(await prisma.assignmentRule.create({ data: { ...data, position: (last._max.position ?? 0) + 1 } }));
});
rulesRouter.put('/:id', async (req, res) => {
  res.json(await prisma.assignmentRule.update({ where: { id: String(req.params.id) }, data: ruleSchema.parse(req.body) }));
});
rulesRouter.delete('/:id', async (req, res) => {
  await prisma.assignmentRule.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});
rulesRouter.post('/reorder', async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string()) }).parse(req.body);
  await prisma.$transaction(ids.map((id, position) => prisma.assignmentRule.update({ where: { id }, data: { position } })));
  res.json({ ok: true });
});
/** Dry-run: which rules would match this text, and what would happen? Nothing is written. */
rulesRouter.post('/test', async (req, res) => {
  const { subject, description } = z.object({ subject: z.string().default(''), description: z.string().default('') }).parse(req.body);
  const rules = await prisma.assignmentRule.findMany({ where: { enabled: true }, orderBy: { position: 'asc' } });
  const outcome = runRules(rules, subject, description);
  const [team, agent, category] = await Promise.all([
    outcome.teamId ? prisma.team.findUnique({ where: { id: outcome.teamId }, select: { name: true, strategy: true } }) : null,
    outcome.agentId ? prisma.user.findUnique({ where: { id: outcome.agentId }, select: { name: true, available: true } }) : null,
    outcome.categoryId ? prisma.category.findUnique({ where: { id: outcome.categoryId } }) : null,
  ]);
  res.json({ ...outcome, team, agent, category });
});

// ---------- Canned responses ----------
export const cannedRouter = Router();
cannedRouter.use(requireRole('AGENT'));
const cannedSchema = z.object({ title: z.string().trim().min(1), body: z.string().min(1) });
cannedRouter.get('/', async (_req, res) => res.json(await prisma.cannedResponse.findMany({ orderBy: { title: 'asc' } })));
cannedRouter.post('/', requireRole('ADMIN'), async (req, res) => res.status(201).json(await prisma.cannedResponse.create({ data: cannedSchema.parse(req.body) })));
cannedRouter.put('/:id', requireRole('ADMIN'), async (req, res) =>
  res.json(await prisma.cannedResponse.update({ where: { id: String(req.params.id) }, data: cannedSchema.parse(req.body) })),
);
cannedRouter.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  await prisma.cannedResponse.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

// ---------- Settings ----------
export const settingsRouter = Router();
const sla = z.object({ firstResponseHours: z.number().positive(), resolutionHours: z.number().positive() });
settingsRouter.get('/', requireRole('AGENT'), async (_req, res) => res.json(await getSettings()));
settingsRouter.put('/', requireRole('ADMIN'), async (req, res) => {
  const patch = z
    .object({
      defaultTeamId: z.string().nullable().optional(),
      sla: z.object({ LOW: sla, NORMAL: sla, HIGH: sla, URGENT: sla }).optional(),
      autoCloseDays: z.number().int().min(0).optional(),
      sendAcknowledgement: z.boolean().optional(),
      reopenOnReply: z.boolean().optional(),
      helpdeskName: z.string().min(1).optional(),
    })
    .parse(req.body);
  res.json(await saveSettings(patch));
});

// ---------- Mail log ----------
export const mailLogRouter = Router();
mailLogRouter.get('/', requireRole('ADMIN'), async (_req, res) =>
  res.json(await prisma.inboundEmail.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })),
);

// ---------- Dashboard stats ----------
export const statsRouter = Router();
statsRouter.get('/', requireRole('AGENT'), async (req, res) => {
  const open = { status: { in: [...OPEN_STATUSES] } };
  const since = new Date(Date.now() - 13 * 86400_000);
  since.setHours(0, 0, 0, 0);
  const [byStatus, byPriority, unassigned, overdue, mine, recent, byTeam, resolved] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], _count: true }),
    prisma.ticket.groupBy({ by: ['priority'], where: open, _count: true }),
    prisma.ticket.count({ where: { ...open, assigneeId: null } }),
    prisma.ticket.count({ where: { ...open, resolutionDue: { lt: new Date() } } }),
    prisma.ticket.count({ where: { ...open, assigneeId: req.user!.id } }),
    prisma.ticket.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, channel: true } }),
    prisma.ticket.groupBy({ by: ['teamId'], where: open, _count: true }),
    prisma.ticket.findMany({ where: { resolvedAt: { gte: since } }, select: { createdAt: true, resolvedAt: true, firstResponseAt: true } }),
  ]);
  const days: Record<string, number> = {};
  for (let i = 0; i < 14; i++) days[new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10)] = 0;
  for (const t of recent) {
    const k = t.createdAt.toISOString().slice(0, 10);
    if (k in days) days[k]++;
  }
  const channels: Record<string, number> = {};
  for (const t of recent) channels[t.channel] = (channels[t.channel] ?? 0) + 1;
  const teams = await prisma.team.findMany({ select: { id: true, name: true } });
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  res.json({
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
    byPriority: Object.fromEntries(byPriority.map((s) => [s.priority, s._count])),
    unassigned,
    overdue,
    mine,
    createdPerDay: Object.entries(days).map(([date, count]) => ({ date, count })),
    channels,
    byTeam: byTeam.map((t) => ({ team: teams.find((x) => x.id === t.teamId)?.name ?? 'No team', count: t._count })),
    avgResolutionHours: avg(resolved.map((t) => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3600_000)),
    avgFirstResponseHours: avg(resolved.filter((t) => t.firstResponseAt).map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / 3600_000)),
  });
});
