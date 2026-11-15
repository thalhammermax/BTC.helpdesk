/**
 * Attachment storage. Two drivers:
 *  - local: files under UPLOAD_DIR (development, single-server installs)
 *  - azure: Azure Blob Storage. Authenticates with the app's managed identity
 *    (AZURE_STORAGE_ACCOUNT) or a connection string (AZURE_STORAGE_CONNECTION_STRING, e.g. Azurite).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from '../config.js';

const root = () => path.resolve(config.uploadDir);

function localPath(storageKey: string): string {
  const full = path.resolve(root(), storageKey);
  if (!full.startsWith(root() + path.sep)) throw new Error('Invalid storage key');
  return full;
}

let container: ContainerClient | undefined;
let containerReady: Promise<unknown> | undefined;
async function blobContainer(): Promise<ContainerClient> {
  if (!container) {
    const s = config.storage;
    const service = s.connectionString
      ? BlobServiceClient.fromConnectionString(s.connectionString)
      : new BlobServiceClient(`https://${s.account}.blob.core.windows.net`, new DefaultAzureCredential());
    container = service.getContainerClient(s.container);
    containerReady = container.createIfNotExists().catch((e) => {
      // With least-privilege identities the container may already exist and creation be forbidden.
      if (e?.statusCode !== 403 && e?.statusCode !== 409) throw e;
    });
  }
  await containerReady;
  return container;
}

export function newStorageKey(ticketId: number, filename: string) {
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
  return `${ticketId}/${crypto.randomUUID()}-${safe}`;
}

export async function saveFile(ticketId: number, filename: string, data: Buffer, contentType = 'application/octet-stream'): Promise<string> {
  const key = newStorageKey(ticketId, filename);
  if (config.storage.driver === 'azure') {
    const c = await blobContainer();
    await c.getBlockBlobClient(key).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  } else {
    const full = localPath(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, data);
  }
  return key;
}

export async function readFile(storageKey: string): Promise<Buffer> {
  if (config.storage.driver === 'azure') return (await blobContainer()).getBlockBlobClient(storageKey).downloadToBuffer();
  return fsp.readFile(localPath(storageKey));
}

export async function openStream(storageKey: string): Promise<Readable> {
  if (config.storage.driver === 'azure') {
    const res = await (await blobContainer()).getBlockBlobClient(storageKey).download();
    return res.readableStreamBody as Readable;
  }
  return fs.createReadStream(localPath(storageKey));
}
