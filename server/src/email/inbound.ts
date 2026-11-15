import { simpleParser, type AddressObject } from 'mailparser';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { addMessage, createTicket, findOrCreateUserByEmail, logEvent } from '../services/tickets.js';
import { cleanSubject, extractTicketId, htmlToText, isAutomatedEmail, referencedMessageIds, stripQuotedReply } from './parse.js';

const addrs = (a?: AddressObject | AddressObject[]) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value).filter((v) => v.address) as { address: string; name: string }[];

export type InboundResult = { status: 'created' | 'appended' | 'skipped' | 'duplicate'; ticketId?: number; reason?: string };

/**
 * Turn one raw RFC 822 message into a new ticket or a reply on an existing ticket.
 * `externalId` uniquely identifies the message in the source mailbox (for idempotency).
 */
export async function processRawEmail(raw: Buffer | string, externalId: string): Promise<InboundResult> {
  if (await prisma.inboundEmail.findUnique({ where: { externalId } })) return { status: 'duplicate' };

  const mail = await simpleParser(raw);
  const from = addrs(mail.from)[0];
  const subject = mail.subject ?? '';
  const messageId = mail.messageId;
  const record = (status: string, ticketId?: number, error?: string) =>
    prisma.inboundEmail.create({ data: { externalId, messageId, from: from?.address ?? '', subject, status, ticketId, error } });

  if (messageId && (await prisma.message.findUnique({ where: { emailMessageId: messageId } }))) {
    await record('duplicate');
    return { status: 'duplicate' };
  }
  if (!from) {
    await record('skipped', undefined, 'no sender');
    return { status: 'skipped', reason: 'no sender' };
  }
  const sender = from.address.toLowerCase();
  if (sender === config.mail.address) {
    await record('skipped', undefined, 'from helpdesk mailbox');
    return { status: 'skipped', reason: 'loop' };
  }
  if (isAutomatedEmail(mail.headers, subject, sender)) {
    await record('skipped', undefined, 'automated');
    return { status: 'skipped', reason: 'automated' };
  }
  const domain = sender.split('@')[1];
  const existingUser = await prisma.user.findUnique({ where: { email: sender } });
  if (config.mail.allowedDomains.length && !config.mail.allowedDomains.includes(domain) && !existingUser) {
    await record('skipped', undefined, `domain ${domain} not allowed`);
    return { status: 'skipped', reason: 'domain' };
  }

  const fullText = (mail.text ?? (mail.html ? htmlToText(mail.html) : '')).trim();
  const files = (mail.attachments ?? [])
    .filter((a) => !(a.related && a.size < 15_000)) // skip small inline images such as signature logos
    .map((a) => ({ filename: a.filename ?? 'attachment', contentType: a.contentType, data: a.content }));

  // Is this a reply to an existing ticket?
  let ticketId: number | undefined;
  const refs = referencedMessageIds(mail.inReplyTo, mail.references);
  if (refs.length) {
    const hit = await prisma.message.findFirst({ where: { emailMessageId: { in: refs } }, select: { ticketId: true } });
    ticketId = hit?.ticketId;
  }
  ticketId ??= extractTicketId(subject);
  const existing = ticketId ? await prisma.ticket.findUnique({ where: { id: ticketId } }) : null;

  const author = existingUser ?? (await findOrCreateUserByEmail(sender, from.name));

  if (existing && existing.status !== 'CLOSED') {
    const body = stripQuotedReply(fullText) || fullText || '(empty message)';
    await addMessage({ ticketId: existing.id, author, body, channel: 'EMAIL', files, emailMessageId: messageId });
    // add unknown participants as watchers so they're kept in the loop
    if (author.role === 'REQUESTER' && author.id !== existing.requesterId)
      await prisma.ticketWatcher.upsert({
        where: { ticketId_userId: { ticketId: existing.id, userId: author.id } },
        update: {},
        create: { ticketId: existing.id, userId: author.id },
      });
    await record('appended', existing.id);
    return { status: 'appended', ticketId: existing.id };
  }

  const cc = [...addrs(mail.to), ...addrs(mail.cc)]
    .map((a) => a.address.toLowerCase())
    .filter((a) => a !== config.mail.address && a !== sender);
  const ticket = await createTicket({
    subject: cleanSubject(subject),
    description: existing ? stripQuotedReply(fullText) || fullText : fullText || '(empty message)',
    bodyHtml: mail.html || undefined,
    requester: author,
    channel: 'EMAIL',
    ccEmails: cc,
    files,
    emailMessageId: messageId,
    tags: existing ? ['follow-up'] : [],
  });
  if (existing) await logEvent(ticket.id, null, 'follow_up_of', { ticketId: existing.id });
  await record('created', ticket.id);
  return { status: 'created', ticketId: ticket.id };
}
