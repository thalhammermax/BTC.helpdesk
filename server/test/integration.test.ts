/**
 * End-to-end test against a real PostgreSQL database.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dbUrl = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';
process.env.DEV_LOGIN = 'true';
process.env.MAIL_ADDRESS = 'helpdesk@corp.test';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'hd-test-uploads');
process.env.ENTRA_ROLES_AUTHORITATIVE = 'false';

describe.skipIf(!dbUrl)('help desk end-to-end', () => {
  let server: Server;
  let base: string;
  let prisma: typeof import('../src/db.js').prisma;
  let processRawEmail: typeof import('../src/email/inbound.js').processRawEmail;
  const cookies: Record<string, string> = {};

  async function login(email: string, role: string) {
    const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, role }) });
    expect(r.status).toBe(200);
    cookies[email] = r.headers.get('set-cookie')!.split(';')[0];
  }
  const api = async (who: string, p: string, init: RequestInit & { json?: unknown } = {}) => {
    const r = await fetch(`${base}/api${p}`, {
      ...init,
      headers: { cookie: cookies[who], ...(init.json ? { 'content-type': 'application/json' } : {}) },
      body: init.json ? JSON.stringify(init.json) : init.body,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const eml = (o: { from: string; subject: string; body: string; id: string; inReplyTo?: string; extra?: string }) =>
    [
      `From: ${o.from}`,
      `To: helpdesk@corp.test`,
      `Cc: boss@corp.test`,
      `Subject: ${o.subject}`,
      `Message-ID: ${o.id}`,
      ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
      ...(o.extra ? [o.extra] : []),
      'Content-Type: text/plain; charset=utf-8',
      '',
      o.body,
    ].join('\r\n');

  beforeAll(async () => {
    ({ prisma } = await import('../src/db.js'));
    ({ processRawEmail } = await import('../src/email/inbound.js'));
    await prisma.$executeRawUnsafe(
      'TRUNCATE "TicketEvent","TicketWatcher","Attachment","Message","Ticket","AssignmentRule","TeamMember","Team","Category","CannedResponse","Setting","InboundEmail","User" RESTART IDENTITY CASCADE',
    );
    const { createApp } = await import('../src/index.js');
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await login('admin@corp.test', 'ADMIN');
    await login('alice@corp.test', 'AGENT');
    await login('bob@corp.test', 'AGENT');
    await login('jane@corp.test', 'REQUESTER');
  });
  afterAll(async () => {
    server?.close();
    await prisma?.$disconnect();
  });

  let ticketId: number;

  it('admin configures a team and a keyword rule', async () => {
    const users = await api('admin@corp.test', '/users?role=AGENT');
    const ids = users.body.map((u: { id: string }) => u.id);
    const team = await api('admin@corp.test', '/teams', { method: 'POST', json: { name: 'Network', strategy: 'ROUND_ROBIN', memberIds: ids } });
    expect(team.status).toBe(201);
    const rule = await api('admin@corp.test', '/rules', {
      method: 'POST',
      json: { name: 'VPN', keywords: ['vpn', 'wi-fi'], assignTeamId: team.body.id, setPriority: 'HIGH', addTags: ['network'] },
    });
    expect(rule.status).toBe(201);
    const dry = await api('admin@corp.test', '/rules/test', { method: 'POST', json: { subject: 'VPN down', description: '' } });
    expect(dry.body.team.name).toBe('Network');
    expect(dry.body.matchedRules[0].hits).toEqual(['vpn']);
    // requesters cannot manage rules
    expect((await api('jane@corp.test', '/rules')).status).toBe(403);
  });

  it('inbound email creates an auto-assigned ticket', async () => {
    const r = await processRawEmail(eml({ from: 'Jane Doe <jane@corp.test>', subject: 'My VPN will not connect', body: 'Since this morning.', id: '<m1@mail.corp.test>' }), 'test:1');
    expect(r.status).toBe('created');
    ticketId = r.ticketId!;
    const t = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { assignee: true, team: true, watchers: { include: { user: true } } } });
    expect(t!.team!.name).toBe('Network');
    expect(['alice@corp.test', 'bob@corp.test']).toContain(t!.assignee!.email);
    expect(t!.priority).toBe('HIGH');
    expect(t!.tags).toContain('network');
    expect(t!.status).toBe('OPEN');
    expect(t!.channel).toBe('EMAIL');
    expect(t!.watchers.map((w) => w.user.email)).toEqual(['boss@corp.test']);
    expect(t!.autoAssignedRule).toBe('VPN');
  });

  it('round robin gives the next ticket to the other agent', async () => {
    const first = await prisma.ticket.findUnique({ where: { id: ticketId } });
    const r = await processRawEmail(eml({ from: 'jane@corp.test', subject: 'Wi-Fi drops', body: 'x', id: '<m2@mail.corp.test>' }), 'test:2');
    const second = await prisma.ticket.findUnique({ where: { id: r.ticketId! } });
    expect(second!.assigneeId).not.toBe(first!.assigneeId);
  });

  it('duplicate and automated emails are ignored', async () => {
    expect((await processRawEmail('x', 'test:1')).status).toBe('duplicate');
    const auto = await processRawEmail(eml({ from: 'jane@corp.test', subject: 'Automatic reply: away', body: 'x', id: '<m3@x>', extra: 'Auto-Submitted: auto-replied' }), 'test:3');
    expect(auto.status).toBe('skipped');
  });

  it('agent replies publicly and adds an internal note', async () => {
    const t = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { assignee: true } });
    const agent = t!.assignee!.email;
    const reply = await api(agent, `/tickets/${ticketId}/messages`, { method: 'POST', json: { body: 'Please restart.' } });
    expect(reply.status).toBe(201);
    expect(reply.body.emailMessageId).toMatch(/^<hd-/);
    await api(agent, `/tickets/${ticketId}/messages`, { method: 'POST', json: { body: 'secret note', internal: true } });
    const after = await prisma.ticket.findUnique({ where: { id: ticketId } });
    expect(after!.status).toBe('PENDING');
    expect(after!.firstResponseAt).not.toBeNull();
  });

  it('email reply threads into the ticket via In-Reply-To and reopens it', async () => {
    const sent = await prisma.message.findFirst({ where: { ticketId, body: 'Please restart.' } });
    const r = await processRawEmail(
      eml({ from: 'jane@corp.test', subject: 'RE: something unrelated', body: 'Restarted, still broken.\n\nOn Mon, Help Desk wrote:\n> Please restart.', id: '<m4@mail.corp.test>', inReplyTo: sent!.emailMessageId! }),
      'test:4',
    );
    expect(r).toEqual({ status: 'appended', ticketId });
    const msg = await prisma.message.findUnique({ where: { emailMessageId: '<m4@mail.corp.test>' } });
    expect(msg!.body).toBe('Restarted, still broken.');
    expect((await prisma.ticket.findUnique({ where: { id: ticketId } }))!.status).toBe('OPEN');
  });

  it('subject tag threads replies too', async () => {
    const r = await processRawEmail(eml({ from: 'jane@corp.test', subject: `Re: [#${ticketId}] My VPN`, body: 'one more thing', id: '<m5@x>' }), 'test:5');
    expect(r.ticketId).toBe(ticketId);
  });

  it('requester sees their ticket but not internal notes; other requesters cannot', async () => {
    const mine = await api('jane@corp.test', '/tickets');
    expect(mine.body.total).toBe(2);
    const detail = await api('jane@corp.test', `/tickets/${ticketId}`);
    expect(detail.body.messages.some((m: { body: string }) => m.body === 'secret note')).toBe(false);
    expect(detail.body.events).toBeUndefined();
    await login('mallory@corp.test', 'REQUESTER');
    expect((await api('mallory@corp.test', `/tickets/${ticketId}`)).status).toBe(404);
    expect((await api('jane@corp.test', `/tickets/${ticketId}`, { method: 'PATCH', json: { status: 'CLOSED' } })).status).toBe(403);
  });

  it('web ticket with attachment from requester; search and stats work', async () => {
    const form = new FormData();
    form.set('subject', 'Need new monitor');
    form.set('description', 'Mine is flickering');
    form.append('files', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const created = await api('jane@corp.test', '/tickets', { method: 'POST', body: form });
    expect(created.status).toBe(201);
    expect(created.body.channel).toBe('WEB');
    const detail = await api('jane@corp.test', `/tickets/${created.body.id}`);
    const att = detail.body.messages[0].attachments[0];
    const file = await fetch(`${base}/api/attachments/${att.id}`, { headers: { cookie: cookies['jane@corp.test'] } });
    expect(await file.text()).toBe('hello');
    const search = await api('admin@corp.test', '/tickets?view=all&q=monitor');
    expect(search.body.total).toBe(1);
    const stats = await api('admin@corp.test', '/stats');
    expect(stats.body.byStatus.OPEN + (stats.body.byStatus.NEW ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('resolve then merge', async () => {
    const res = await api('admin@corp.test', `/tickets/${ticketId}`, { method: 'PATCH', json: { status: 'RESOLVED' } });
    expect(res.body.resolvedAt).not.toBeNull();
    const other = await prisma.ticket.findFirst({ where: { subject: 'Wi-Fi drops' } });
    const m = await api('admin@corp.test', `/tickets/${other!.id}/merge`, { method: 'POST', json: { intoId: ticketId } });
    expect(m.status).toBe(200);
    expect((await prisma.ticket.findUnique({ where: { id: other!.id } }))!.status).toBe('CLOSED');
  });
});
