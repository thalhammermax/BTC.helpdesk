export type Role = 'REQUESTER' | 'AGENT' | 'ADMIN';
export type Status = 'NEW' | 'OPEN' | 'PENDING' | 'ON_HOLD' | 'RESOLVED' | 'CLOSED';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export const STATUSES: Status[] = ['NEW', 'OPEN', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED'];
export const PRIORITIES: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export interface UserLite { id: string; name: string; email: string; role: Role }
export interface User extends UserLite { active: boolean; available: boolean; lastLoginAt?: string; teams?: { teamId: string }[] }
export interface Me extends UserLite { isAgent: boolean; available: boolean; helpdeskName: string }
export interface Team { id: string; name: string; description?: string; email?: string; strategy: 'NONE' | 'ROUND_ROBIN' | 'LEAST_LOADED'; members: { user: User }[]; _count?: { tickets: number } }
export interface Category { id: string; name: string }
export interface Attachment { id: string; filename: string; contentType: string; size: number }
export interface Message { id: string; body: string; internal: boolean; channel: string; createdAt: string; author?: UserLite; attachments: Attachment[] }
export interface TicketEvent { id: string; type: string; data: Record<string, unknown> | null; createdAt: string; actor?: UserLite }
export interface Ticket {
  id: number; subject: string; description: string; status: Status; priority: Priority; channel: string; tags: string[];
  requester: UserLite; assignee?: UserLite | null; team?: { id: string; name: string } | null; category?: Category | null;
  assigneeId?: string | null; teamId?: string | null; categoryId?: string | null;
  autoAssignedRule?: string | null; firstResponseAt?: string; firstResponseDue?: string; resolutionDue?: string; resolvedAt?: string;
  sourceUrl?: string; createdAt: string; updatedAt: string; _count?: { messages: number };
  messages?: Message[]; events?: TicketEvent[]; watchers?: { user: UserLite }[];
}
export interface Rule {
  id: string; name: string; enabled: boolean; position: number; matchField: 'SUBJECT' | 'DESCRIPTION' | 'BOTH'; matchMode: 'ANY' | 'ALL';
  keywords: string[]; excludeKeywords: string[]; wholeWord: boolean; assignTeamId?: string | null; assignAgentId?: string | null;
  setPriority?: Priority | null; setCategoryId?: string | null; addTags: string[]; stopProcessing: boolean; hitCount: number;
  team?: { name: string } | null; agent?: { name: string } | null; category?: Category | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, opts: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path.startsWith('/auth') ? path : `/api${path}`, {
    method: opts.method ?? (opts.json || opts.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: opts.json ? { 'content-type': 'application/json' } : undefined,
    body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = body.issues?.map((i: { path: string[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError(res.status, issues || body.error || res.statusText);
  }
  return body as T;
}

export const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export function ago(iso?: string) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const fut = s < 0;
  const a = Math.abs(s);
  const v = a < 60 ? 'just now' : a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : `${Math.floor(a / 86400)}d`;
  return v === 'just now' ? v : fut ? `in ${v}` : `${v} ago`;
}
export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
