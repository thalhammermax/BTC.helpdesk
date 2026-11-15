import type { Message, Ticket, User } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { REPLY_MARKER, ticketTag } from '../email/parse.js';
import { sendMail } from '../email/outbound.js';
import { readFile } from '../lib/storage.js';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ticketLink = (id: number) => `${config.appUrl}/tickets/${id}`;

function layout(title: string, bodyText: string, id: number, footer: string) {
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<p style="color:#999;font-size:12px">${esc(REPLY_MARKER)}</p>
<h3 style="margin:0 0 12px">${esc(title)}</h3>
<div style="white-space:pre-wrap">${esc(bodyText)}</div>
<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
<p style="color:#777;font-size:12px">${esc(footer)}<br><a href="${ticketLink(id)}">View ticket #${id}</a></p></div>`;
  const text = `${REPLY_MARKER}\n\n${title}\n\n${bodyText}\n\n--\n${footer}\n${ticketLink(id)}`;
  return { html, text };
}

async function threadRefs(ticketId: number) {
  const msgs = await prisma.message.findMany({
    where: { ticketId, emailMessageId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { emailMessageId: true },
  });
  const refs = msgs.map((m) => m.emailMessageId!).slice(-10);
  return { references: refs, inReplyTo: refs[refs.length - 1] };
}

async function watcherEmails(ticketId: number) {
  const w = await prisma.ticketWatcher.findMany({ where: { ticketId }, include: { user: true } });
  return w.map((x) => x.user.email);
}

type T = Ticket & { requester: User };

export async function notifyRequesterCreated(t: T) {
  const { text, html } = layout(
    `We received your request: ${t.subject}`,
    `Hi ${t.requester.name},\n\nThanks for contacting us. Your ticket number is #${t.id}. ` +
      `Our team will get back to you shortly. You can reply to this email to add more information.`,
    t.id,
    'Please keep the ticket number in the subject when replying.',
  );
  return sendMail({
    to: [t.requester.email],
    cc: await watcherEmails(t.id),
    subject: `${ticketTag(t.id)} ${t.subject}`,
    text,
    html,
    ticketId: t.id,
    automated: true,
    ...(await threadRefs(t.id)),
  });
}

/** Public reply from an agent → requester + CC watchers. Returns Message-ID to store for threading. */
export async function notifyRequesterReply(t: T, msg: Message, author: User) {
  const files = await prisma.attachment.findMany({ where: { messageId: msg.id } });
  const attachments = await Promise.all(
    files.map(async (f) => ({ filename: f.filename, contentType: f.contentType, content: await readFile(f.storageKey) })),
  );
  const { text, html } = layout(`${author.name} replied`, msg.body, t.id, `Status: ${t.status.replace('_', ' ')}`);
  return sendMail({
    to: [t.requester.email],
    cc: (await watcherEmails(t.id)).filter((e) => e !== author.email),
    subject: `Re: ${ticketTag(t.id)} ${t.subject}`,
    text,
    html,
    ticketId: t.id,
    attachments,
    ...(await threadRefs(t.id)),
  });
}

export async function notifyRequesterStatus(t: T, status: 'RESOLVED' | 'CLOSED') {
  const { text, html } = layout(
    `Your ticket has been ${status.toLowerCase()}`,
    `Hi ${t.requester.name},\n\nTicket #${t.id} "${t.subject}" has been marked as ${status.toLowerCase()}. ` +
      (status === 'RESOLVED' ? 'If the issue is not fixed, just reply to this email and the ticket will be reopened.' : ''),
    t.id,
    'Thank you for using the help desk.',
  );
  return sendMail({ to: [t.requester.email], subject: `${ticketTag(t.id)} ${t.subject}`, text, html, ticketId: t.id, automated: true, ...(await threadRefs(t.id)) });
}

/** Notify agents (assignee, or whole team if unassigned). */
export async function notifyAgents(
  t: Ticket,
  kind: 'new' | 'assigned' | 'reply' | 'note',
  body: string,
  exclude?: string,
) {
  let recipients: User[] = [];
  if (t.assigneeId) {
    const a = await prisma.user.findUnique({ where: { id: t.assigneeId } });
    if (a) recipients = [a];
  } else if (t.teamId) {
    const members = await prisma.teamMember.findMany({ where: { teamId: t.teamId }, include: { user: true } });
    recipients = members.map((m) => m.user);
  }
  const to = recipients.filter((u) => u.active && u.id !== exclude).map((u) => u.email);
  if (!to.length) return;
  const titles = {
    new: `New ticket #${t.id}: ${t.subject}`,
    assigned: `Ticket #${t.id} assigned to you: ${t.subject}`,
    reply: `Requester replied on #${t.id}: ${t.subject}`,
    note: `Internal note on #${t.id}: ${t.subject}`,
  };
  const { text, html } = layout(titles[kind], body, t.id, `Priority: ${t.priority} · Status: ${t.status}`);
  await sendMail({ to, subject: `${ticketTag(t.id)} ${titles[kind]}`, text, html, ticketId: t.id, automated: true });
}
