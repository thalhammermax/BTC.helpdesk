import { ImapFlow } from 'imapflow';
import { config } from '../config.js';
import { processRawEmail } from './inbound.js';

/** Pull unseen messages via IMAP (for non-Microsoft 365 mailboxes). */
export async function pollImap(): Promise<number> {
  const c = config.mail.imap;
  const client = new ImapFlow({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  let n = 0;
  const lock = await client.getMailboxLock(c.mailbox);
  try {
    const mb = client.mailbox;
    const validity = mb && typeof mb === 'object' ? String(mb.uidValidity) : '0';
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      try {
        const r = await processRawEmail(msg.source, `imap:${c.user}:${validity}:${uid}`);
        console.log(`[mail] imap uid ${uid} → ${r.status}${r.ticketId ? ` #${r.ticketId}` : ''}`);
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        n++;
      } catch (e) {
        console.error('[mail] failed to process imap uid', uid, (e as Error).message);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return n;
}
