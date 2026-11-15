/** Pure helpers for inbound/outbound email handling. */

export const REPLY_MARKER = '##- Please type your reply above this line -##';

export function ticketTag(id: number) {
  return `[#${id}]`;
}

/** Finds a ticket reference such as "[#123]" or "[Ticket #123]" in a subject line. */
export function extractTicketId(subject: string): number | undefined {
  const m = /\[(?:ticket\s*)?#(\d+)\]/i.exec(subject ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Removes "Re:", "Fwd:" prefixes and the ticket tag. */
export function cleanSubject(subject: string): string {
  let s = (subject ?? '').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i, '');
    s = s.replace(/\[(?:ticket\s*)?#\d+\]\s*/i, '');
  } while (s !== prev);
  return s.trim() || '(no subject)';
}

const QUOTE_HEADERS = [
  new RegExp(`^.*${REPLY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm'),
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m, // Outlook separator line
  /^On .{1,200}(\n.{0,200})?wrote:\s*$/m,
  /^Am .{1,200} schrieb .{1,200}:\s*$/m,
  /^From:\s.+\n(Sent|Date):\s.+/im,
  /^Von:\s.+\n(Gesendet|Datum):\s.+/im,
];

/** Strip quoted history from a reply so only the new text is stored. */
export function stripQuotedReply(text: string): string {
  if (!text) return '';
  let body = text.replace(/\r\n/g, '\n');
  let cut = body.length;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(body);
    if (m && m.index < cut && m.index > 0) cut = m.index;
  }
  body = body.slice(0, cut);
  // drop trailing ">" quoted lines
  const lines = body.split('\n');
  while (lines.length && (/^\s*>/.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n').trim();
}

type HeaderValue = string | string[] | { value?: string; text?: string } | undefined | unknown;
const headerText = (v: HeaderValue): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(' ');
  if (typeof v === 'object') return String((v as { value?: string; text?: string }).value ?? (v as { text?: string }).text ?? '');
  return String(v);
};

/** Detects auto-replies, bounces and bulk mail that must not create tickets (prevents mail loops). */
export function isAutomatedEmail(headers: Map<string, unknown> | Record<string, unknown>, subject = '', from = ''): boolean {
  const get = (k: string) => headerText(headers instanceof Map ? headers.get(k) : (headers as Record<string, unknown>)[k]).toLowerCase();
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (get('x-autoreply') || get('x-autorespond') || get('x-auto-response-suppress').includes('all')) return true;
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(get('precedence'))) return true;
  if (get('x-helpdesk-ticket')) return true; // our own outbound mail
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from)) return true;
  if (/^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification|abwesenheitsnotiz)/i.test(subject.trim()))
    return true;
  return false;
}

/** Collect candidate Message-IDs a reply may refer to. */
export function referencedMessageIds(inReplyTo?: string, references?: string | string[]): string[] {
  const all = [inReplyTo ?? '', ...(Array.isArray(references) ? references : [references ?? ''])].join(' ');
  return [...new Set(all.match(/<[^<>\s]+>/g) ?? [])];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
