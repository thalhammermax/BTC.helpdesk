import { describe, expect, it } from 'vitest';
import { cleanSubject, extractTicketId, isAutomatedEmail, referencedMessageIds, REPLY_MARKER, stripQuotedReply } from '../src/email/parse.js';

describe('email parsing', () => {
  it('extracts ticket ids from subjects', () => {
    expect(extractTicketId('Re: [#42] Printer broken')).toBe(42);
    expect(extractTicketId('RE: [Ticket #7] x')).toBe(7);
    expect(extractTicketId('Order #42 shipped')).toBeUndefined();
  });
  it('cleans subjects', () => {
    expect(cleanSubject('RE: Fwd: [#42] Printer broken')).toBe('Printer broken');
    expect(cleanSubject('')).toBe('(no subject)');
  });
  it('strips quoted replies', () => {
    const gmail = 'Thanks, that worked!\n\nOn Mon, Nov 10, 2026 at 9:00 AM Help Desk <hd@x.com> wrote:\n> old text';
    expect(stripQuotedReply(gmail)).toBe('Thanks, that worked!');
    const outlook = 'Still broken.\r\n\r\nFrom: Help Desk <hd@x.com>\r\nSent: Monday\r\nTo: me\r\n\r\nold';
    expect(stripQuotedReply(outlook)).toBe('Still broken.');
    const marker = `New info here\n\n${REPLY_MARKER}\nquoted`;
    expect(stripQuotedReply(marker)).toBe('New info here');
    expect(stripQuotedReply('just text')).toBe('just text');
  });
  it('detects automated mail', () => {
    expect(isAutomatedEmail(new Map([['auto-submitted', 'auto-replied']]))).toBe(true);
    expect(isAutomatedEmail(new Map([['auto-submitted', 'no']]))).toBe(false);
    expect(isAutomatedEmail(new Map(), 'Automatic reply: Away')).toBe(true);
    expect(isAutomatedEmail(new Map(), 'Help', 'noreply@vendor.com')).toBe(true);
    expect(isAutomatedEmail(new Map(), 'Laptop issue', 'jane@corp.com')).toBe(false);
  });
  it('collects referenced message ids', () => {
    expect(referencedMessageIds('<a@x>', ['<b@x>', '<a@x>'])).toEqual(['<a@x>', '<b@x>']);
  });
});
