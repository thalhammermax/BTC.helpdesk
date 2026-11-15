import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.MAIL_ADDRESS = 'helpdesk@corp.test';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'hd@proj.iam.gserviceaccount.com', private_key: pem });

const processRawEmail = vi.fn();
vi.mock('../src/email/inbound.js', () => ({ processRawEmail }));

let gmail: typeof import('../src/email/gmail.js');
beforeAll(async () => {
  gmail = await import('../src/email/gmail.js');
});

type Call = { url: string; method: string; body?: string };
function mockFetch(routes: (c: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? 'GET', body: init.body?.toString() };
    calls.push(c);
    const out = routes(c);
    return new Response(JSON.stringify(out ?? {}), { status: 200 });
  }));
  return calls;
}
afterEach(() => {
  vi.unstubAllGlobals();
  processRawEmail.mockReset();
});

describe('gmail connector', () => {
  it('builds a domain-wide delegation assertion that impersonates the help desk mailbox', async () => {
    const jwt = await gmail.serviceAccountAssertion({ client_email: 'hd@proj.iam.gserviceaccount.com', private_key: pem }, 'helpdesk@corp.test');
    const key = await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'RS256');
    const { payload } = await jwtVerify(jwt, key, { audience: 'https://oauth2.googleapis.com/token' });
    expect(payload).toMatchObject({ iss: 'hd@proj.iam.gserviceaccount.com', sub: 'helpdesk@corp.test', scope: gmail.GMAIL_SCOPE });
  });

  it('imports unprocessed inbox messages oldest-first, then labels and archives them', async () => {
    gmail.resetGmailToken();
    const raw = Buffer.from('From: a@corp.test\r\nSubject: hi\r\n\r\nbody').toString('base64url');
    processRawEmail.mockImplementation(async (_raw: Buffer, id: string) => {
      if (id === 'gmail:bad') throw new Error('boom');
      return { status: 'created', ticketId: 1 };
    });
    const calls = mockFetch((c) => {
      if (c.url.includes('oauth2.googleapis.com/token')) return { access_token: 'tok', expires_in: 3600 };
      if (c.url.endsWith('/labels') && c.method === 'GET') return { labels: [{ id: 'INBOX', name: 'INBOX' }] };
      if (c.url.endsWith('/labels') && c.method === 'POST') return { id: 'Label_9' };
      if (c.url.includes('/messages?')) return { messages: [{ id: 'new' }, { id: 'bad' }, { id: 'old' }] };
      if (c.url.includes('format=raw')) return { raw };
      return {};
    });
    expect(await gmail.pollGmail()).toBe(2);
    const token = calls.find((c) => c.url.includes('/token'))!;
    expect(token.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    // parent label created before the nested one
    const labelPosts = calls.filter((c) => c.url.endsWith('/labels') && c.method === 'POST').map((c) => JSON.parse(c.body!).name);
    expect(labelPosts).toEqual(['Helpdesk', 'Helpdesk/Processed']);
    const list = calls.find((c) => c.url.includes('/messages?'))!;
    expect(decodeURIComponent(list.url)).toContain('in:inbox -label:"Helpdesk/Processed"');
    expect(processRawEmail.mock.calls.map((c) => c[1])).toEqual(['gmail:old', 'gmail:bad', 'gmail:new']);
    expect(processRawEmail.mock.calls[0][0].toString()).toContain('Subject: hi');
    const modified = calls.filter((c) => c.url.endsWith('/modify'));
    expect(modified.map((c) => c.url.split('/messages/')[1])).toEqual(['old/modify', 'new/modify']); // failed one is retried later
    expect(JSON.parse(modified[0].body!)).toEqual({ addLabelIds: ['Label_9'], removeLabelIds: ['UNREAD', 'INBOX'] });
  });

  it('sends raw MIME and returns the Message-ID Gmail used', async () => {
    gmail.resetGmailToken();
    const calls = mockFetch((c) => {
      if (c.url.includes('/token')) return { access_token: 'tok', expires_in: 3600 };
      if (c.url.endsWith('/messages/send')) return { id: 's1' };
      if (c.url.includes('/messages/s1?format=metadata')) return { payload: { headers: [{ name: 'Message-Id', value: '<gmail-123@mail.gmail.com>' }] } };
      return {};
    });
    const id = await gmail.sendGmail(Buffer.from('Subject: x\r\n\r\nhello'), '<hd-1@corp.test>');
    expect(id).toBe('<gmail-123@mail.gmail.com>');
    const send = calls.find((c) => c.url.endsWith('/messages/send'))!;
    expect(Buffer.from(JSON.parse(send.body!).raw, 'base64url').toString()).toContain('hello');
  });
});
