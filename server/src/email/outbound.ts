import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from '../config.js';
import { graphAppToken } from '../auth/entra.js';
import { sendGmail } from './gmail.js';

export interface OutboundMail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  ticketId?: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  automated?: boolean;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export function newMessageId(ticketId?: number) {
  const domain = config.mail.address.split('@')[1] ?? 'helpdesk.local';
  return `<hd-${ticketId ?? 0}-${crypto.randomUUID()}@${domain}>`;
}

const mailboxAddress = () => config.mail.address.toLowerCase();

function buildOptions(m: OutboundMail) {
  const headers: Record<string, string> = { 'X-Auto-Response-Suppress': 'All' };
  if (m.ticketId) headers['X-Helpdesk-Ticket'] = String(m.ticketId);
  if (m.automated) headers['Auto-Submitted'] = 'auto-generated';
  const self = mailboxAddress();
  const strip = (l?: string[]) => [...new Set((l ?? []).map((a) => a.toLowerCase()))].filter((a) => a && a !== self);
  return {
    from: { name: config.mail.fromName, address: config.mail.address },
    to: strip(m.to),
    cc: strip(m.cc).filter((a) => !strip(m.to).includes(a)),
    subject: m.subject,
    text: m.text,
    html: m.html,
    messageId: m.messageId ?? newMessageId(m.ticketId),
    inReplyTo: m.inReplyTo,
    references: m.references,
    headers,
    attachments: m.attachments,
  };
}

let smtp: ReturnType<typeof nodemailer.createTransport> | undefined;

/** Sends an email. Returns the Message-ID used, or undefined if there were no recipients. */
export async function sendMail(m: OutboundMail): Promise<string | undefined> {
  const opts = buildOptions(m);
  if (!opts.to.length && !opts.cc.length) return undefined;
  try {
    if (config.mail.outbound === 'smtp') {
      smtp ??= nodemailer.createTransport({
        host: config.mail.smtp.host,
        port: config.mail.smtp.port,
        secure: config.mail.smtp.secure,
        auth: config.mail.smtp.user ? { user: config.mail.smtp.user, pass: config.mail.smtp.pass } : undefined,
      });
      await smtp.sendMail(opts);
    } else if (config.mail.outbound === 'gmail') {
      const mime = await new MailComposer(opts).compile().build();
      return await sendGmail(mime, opts.messageId);
    } else if (config.mail.outbound === 'graph') {
      // Graph accepts a base64 MIME message, which lets us control Message-ID / In-Reply-To for threading.
      const mime = await new MailComposer(opts).compile().build();
      const token = await graphAppToken();
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mail.address)}/sendMail`,
        { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: mime.toString('base64') },
      );
      if (!res.ok) throw new Error(`Graph sendMail ${res.status}: ${await res.text()}`);
    } else {
      console.log(`[mail:log] to=${opts.to.join(',')} cc=${opts.cc.join(',')} subject="${opts.subject}"\n${opts.text}\n`);
    }
  } catch (e) {
    // Email delivery failures must never break ticket operations.
    console.error('[mail] send failed:', (e as Error).message);
  }
  return opts.messageId;
}
