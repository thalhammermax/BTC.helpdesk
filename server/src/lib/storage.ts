import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const root = () => path.resolve(config.uploadDir);

export async function saveFile(ticketId: number, filename: string, data: Buffer): Promise<string> {
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
  const key = `${ticketId}/${crypto.randomUUID()}-${safe}`;
  const full = path.join(root(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return key;
}

export function filePath(storageKey: string): string {
  const full = path.resolve(root(), storageKey);
  if (!full.startsWith(root() + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export const readFile = (storageKey: string) => fs.readFile(filePath(storageKey));
