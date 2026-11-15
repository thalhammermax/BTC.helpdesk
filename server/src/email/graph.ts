import { config } from '../config.js';
import { graphAppToken } from '../auth/entra.js';
import { processRawEmail } from './inbound.js';

const base = () => `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mail.address)}`;

async function graph(path: string, init: RequestInit = {}) {
  const token = await graphAppToken();
  const res = await fetch(path.startsWith('http') ? path : `${base()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Graph ${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return res;
}

let processedFolderId: string | undefined;
async function resolveProcessedFolder(): Promise<string | undefined> {
  const name = config.mail.graphProcessedFolder;
  if (!name) return undefined;
  if (processedFolderId) return processedFolderId;
  const res = await graph(`/mailFolders?$filter=displayName eq '${name.replace(/'/g, "''")}'`);
  const found = ((await res.json()) as { value: { id: string }[] }).value[0];
  if (found) return (processedFolderId = found.id);
  const created = await graph('/mailFolders', { method: 'POST', body: JSON.stringify({ displayName: name }) });
  return (processedFolderId = ((await created.json()) as { id: string }).id);
}

/** Pull unread messages from the support mailbox's Inbox via Microsoft Graph. */
export async function pollGraph(): Promise<number> {
  const res = await graph(`/mailFolders/inbox/messages?$filter=isRead eq false&$select=id,receivedDateTime&$top=25`);
  const items = ((await res.json()) as { value: { id: string; receivedDateTime: string }[] }).value.sort((a, b) =>
    a.receivedDateTime.localeCompare(b.receivedDateTime),
  );
  const folder = await resolveProcessedFolder();
  let n = 0;
  for (const item of items) {
    try {
      const mime = Buffer.from(await (await graph(`/messages/${item.id}/$value`)).arrayBuffer());
      const r = await processRawEmail(mime, `graph:${item.id}`);
      console.log(`[mail] graph message → ${r.status}${r.ticketId ? ` #${r.ticketId}` : ''}${r.reason ? ` (${r.reason})` : ''}`);
      n++;
    } catch (e) {
      console.error('[mail] failed to process graph message', item.id, (e as Error).message);
      continue; // leave unread so it is retried
    }
    await graph(`/messages/${item.id}`, { method: 'PATCH', body: JSON.stringify({ isRead: true }) });
    if (folder) await graph(`/messages/${item.id}/move`, { method: 'POST', body: JSON.stringify({ destinationId: folder }) });
  }
  return n;
}
