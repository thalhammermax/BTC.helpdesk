import type { Channel, Prisma, Priority, Ticket, TicketStatus, User } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../lib/http.js';
import { saveFile } from '../lib/storage.js';
import { decideAssignment, decisionToTicketData, recordRuleHits } from './assignment.js';
import { getSettings, slaDueDates } from './settings.js';
import * as notify from './notify.js';

export interface IncomingFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export async function logEvent(ticketId: number, actorId: string | null | undefined, type: string, data?: Prisma.InputJsonValue) {
  await prisma.ticketEvent.create({ data: { ticketId, actorId: actorId ?? null, type, data } });
}

async function storeAttachments(ticketId: number, messageId: string, files: IncomingFile[] = []) {
  for (const f of files) {
    const storageKey = await saveFile(ticketId, f.filename, f.data);
    await prisma.attachment.create({
      data: { ticketId, messageId, filename: f.filename, contentType: f.contentType || 'application/octet-stream', size: f.data.length, storageKey },
    });
  }
}

export interface CreateTicketInput {
  subject: string;
  description: string;
  bodyHtml?: string;
  requester: User;
  channel: Channel;
  priority?: Priority;
  categoryId?: string | null;
  teamId?: string | null;
  assigneeId?: string | null;
  tags?: string[];
  sourceUrl?: string;
  ccEmails?: string[];
  files?: IncomingFile[];
  emailMessageId?: string;
  actor?: User;
}

export async function findOrCreateUserByEmail(email: string, name?: string): Promise<User> {
  const e = email.trim().toLowerCase();
  return prisma.user.upsert({ where: { email: e }, update: {}, create: { email: e, name: name?.trim() || e.split('@')[0] } });
}

export async function createTicket(input: CreateTicketInput) {
  const settings = await getSettings();
  const explicitAssignment = !!(input.assigneeId || input.teamId);
  const decision = explicitAssignment ? undefined : await decideAssignment(input.subject, input.description);
  const auto = decision ? decisionToTicketData(decision) : {};

  // Rule-defined priority wins over the requester's choice; staff-created tickets with explicit assignment skip rules.
  const priority: Priority = (auto.priority as Priority | undefined) ?? input.priority ?? 'NORMAL';
  const due = slaDueDates(priority, settings.sla);

  const ticket = await prisma.ticket.create({
    data: {
      subject: input.subject.slice(0, 500),
      description: input.description,
      requesterId: input.requester.id,
      channel: input.channel,
      sourceUrl: input.sourceUrl,
      ...auto,
      priority,
      categoryId: input.categoryId ?? (auto.categoryId as string | undefined),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.assigneeId ? { assigneeId: input.assigneeId, status: 'OPEN' } : {}),
      tags: [...new Set([...(input.tags ?? []), ...(decision?.tags ?? [])])],
      firstResponseDue: due.firstResponseDue,
      resolutionDue: due.resolutionDue,
    },
    include: { requester: true },
  });

  const msg = await prisma.message.create({
    data: {
      ticketId: ticket.id,
      authorId: input.requester.id,
      body: input.description,
      bodyHtml: input.bodyHtml,
      channel: input.channel,
      emailMessageId: input.emailMessageId,
    },
  });
  await storeAttachments(ticket.id, msg.id, input.files);

  for (const email of input.ccEmails ?? []) {
    const u = await findOrCreateUserByEmail(email);
    if (u.id !== input.requester.id)
      await prisma.ticketWatcher.upsert({ where: { ticketId_userId: { ticketId: ticket.id, userId: u.id } }, update: {}, create: { ticketId: ticket.id, userId: u.id } });
  }

  await logEvent(ticket.id, input.actor?.id ?? input.requester.id, 'created', { channel: input.channel });
  if (decision) {
    await recordRuleHits(decision);
    if (decision.matchedRules.length || ticket.assigneeId || ticket.teamId)
      await logEvent(ticket.id, null, 'auto_assigned', {
        rules: decision.matchedRules,
        teamId: ticket.teamId,
        assigneeId: ticket.assigneeId,
      } as unknown as Prisma.InputJsonValue);
  }

  if (settings.sendAcknowledgement) await notify.notifyRequesterCreated(ticket);
  await notify.notifyAgents(ticket, ticket.assigneeId ? 'assigned' : 'new', input.description, input.actor?.id);
  return ticket;
}

export interface AddMessageInput {
  ticketId: number;
  author: User;
  body: string;
  bodyHtml?: string;
  internal?: boolean;
  channel: Channel;
  files?: IncomingFile[];
  emailMessageId?: string;
  /** set ticket status together with the reply (agents) */
  status?: TicketStatus;
}

export async function addMessage(input: AddMessageInput) {
  const ticket = await prisma.ticket.findUnique({ where: { id: input.ticketId }, include: { requester: true } });
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  const settings = await getSettings();
  const isStaff = input.author.role !== 'REQUESTER';
  const internal = isStaff && !!input.internal;

  const msg = await prisma.message.create({
    data: {
      ticketId: ticket.id,
      authorId: input.author.id,
      body: input.body,
      bodyHtml: input.bodyHtml,
      internal,
      channel: input.channel,
      emailMessageId: input.emailMessageId,
    },
  });
  await storeAttachments(ticket.id, msg.id, input.files);

  const patch: Prisma.TicketUncheckedUpdateInput = {};
  if (isStaff && !internal) {
    if (!ticket.firstResponseAt) patch.firstResponseAt = new Date();
    patch.status = input.status ?? (['NEW', 'OPEN'].includes(ticket.status) ? 'PENDING' : ticket.status);
    if (!ticket.assigneeId && input.author.role !== 'REQUESTER') patch.assigneeId = input.author.id;
  } else if (isStaff && internal && input.status) {
    patch.status = input.status;
  } else if (!isStaff) {
    if (['PENDING', 'ON_HOLD'].includes(ticket.status) || (ticket.status === 'RESOLVED' && settings.reopenOnReply)) patch.status = 'OPEN';
  }
  if (patch.status === 'RESOLVED') patch.resolvedAt = new Date();
  if (patch.status === 'OPEN' && ticket.status === 'RESOLVED') patch.resolvedAt = null;

  const updated = Object.keys(patch).length
    ? await prisma.ticket.update({ where: { id: ticket.id }, data: patch, include: { requester: true } })
    : ticket;
  if (patch.status && patch.status !== ticket.status)
    await logEvent(ticket.id, input.author.id, 'status', { from: ticket.status, to: patch.status as string });

  if (isStaff && !internal) {
    const sentId = await notify.notifyRequesterReply(updated, msg, input.author);
    if (sentId && !msg.emailMessageId) return prisma.message.update({ where: { id: msg.id }, data: { emailMessageId: sentId } });
  } else if (internal) {
    await notify.notifyAgents(updated, 'note', input.body, input.author.id);
  } else {
    await notify.notifyAgents(updated, 'reply', input.body, input.author.id);
  }
  return msg;
}

export interface TicketPatch {
  subject?: string;
  status?: TicketStatus;
  priority?: Priority;
  assigneeId?: string | null;
  teamId?: string | null;
  categoryId?: string | null;
  tags?: string[];
}

export async function updateTicket(id: number, actor: User, patch: TicketPatch): Promise<Ticket> {
  const before = await prisma.ticket.findUnique({ where: { id }, include: { requester: true } });
  if (!before) throw new HttpError(404, 'Ticket not found');
  const data: Prisma.TicketUncheckedUpdateInput = { ...patch };

  if (patch.status && patch.status !== before.status) {
    if (patch.status === 'RESOLVED') data.resolvedAt = new Date();
    if (patch.status === 'CLOSED') data.closedAt = new Date();
    if (!['RESOLVED', 'CLOSED'].includes(patch.status)) {
      data.resolvedAt = null;
      data.closedAt = null;
    }
  }
  if (patch.priority && patch.priority !== before.priority) {
    const due = slaDueDates(patch.priority, (await getSettings()).sla, before.createdAt);
    data.resolutionDue = due.resolutionDue;
    if (!before.firstResponseAt) data.firstResponseDue = due.firstResponseDue;
  }
  if (patch.assigneeId && before.status === 'NEW' && !patch.status) data.status = 'OPEN';

  const after = await prisma.ticket.update({ where: { id }, data, include: { requester: true } });

  for (const field of ['subject', 'status', 'priority', 'assigneeId', 'teamId', 'categoryId'] as const) {
    if (field in patch && before[field] !== after[field])
      await logEvent(id, actor.id, field === 'assigneeId' ? 'assignee' : field === 'teamId' ? 'team' : field === 'categoryId' ? 'category' : field, {
        from: before[field] as string | null,
        to: after[field] as string | null,
      });
  }
  if (patch.tags && patch.tags.join() !== before.tags.join()) await logEvent(id, actor.id, 'tags', { from: before.tags, to: after.tags });

  if (after.assigneeId && after.assigneeId !== before.assigneeId && after.assigneeId !== actor.id)
    await notify.notifyAgents(after, 'assigned', after.description);
  if (after.status !== before.status && (after.status === 'RESOLVED' || after.status === 'CLOSED') && before.status !== 'RESOLVED')
    await notify.notifyRequesterStatus(after, after.status);
  return after;
}

/** Close resolved tickets that have been quiet for N days. */
export async function autoCloseResolved() {
  const { autoCloseDays } = await getSettings();
  if (!autoCloseDays) return 0;
  const cutoff = new Date(Date.now() - autoCloseDays * 86400_000);
  const stale = await prisma.ticket.findMany({ where: { status: 'RESOLVED', resolvedAt: { lt: cutoff } }, select: { id: true } });
  for (const t of stale) {
    await prisma.ticket.update({ where: { id: t.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await logEvent(t.id, null, 'status', { from: 'RESOLVED', to: 'CLOSED', reason: 'auto-close' });
  }
  return stale.length;
}
