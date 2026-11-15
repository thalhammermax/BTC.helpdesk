import { prisma } from '../db.js';

export interface SlaTarget {
  firstResponseHours: number;
  resolutionHours: number;
}
export interface Settings {
  defaultTeamId: string | null;
  sla: Record<'LOW' | 'NORMAL' | 'HIGH' | 'URGENT', SlaTarget>;
  /** Auto-close resolved tickets after N days without a reply (0 = never) */
  autoCloseDays: number;
  /** Send an acknowledgement email when a ticket is created */
  sendAcknowledgement: boolean;
  /** Reopen resolved tickets when the requester replies */
  reopenOnReply: boolean;
  helpdeskName: string;
}

export const defaults: Settings = {
  defaultTeamId: null,
  sla: {
    URGENT: { firstResponseHours: 1, resolutionHours: 4 },
    HIGH: { firstResponseHours: 4, resolutionHours: 24 },
    NORMAL: { firstResponseHours: 8, resolutionHours: 72 },
    LOW: { firstResponseHours: 24, resolutionHours: 168 },
  },
  autoCloseDays: 7,
  sendAcknowledgement: true,
  reopenOnReply: true,
  helpdeskName: 'Help Desk',
};

export async function getSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany();
  const s: Record<string, unknown> = { ...defaults };
  for (const r of rows) s[r.key] = r.value;
  return s as unknown as Settings;
}
export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as Settings[K]) ?? defaults[key];
}
export async function saveSettings(patch: Partial<Settings>) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaults)) continue;
    await prisma.setting.upsert({ where: { key }, update: { value: value as never }, create: { key, value: value as never } });
  }
  return getSettings();
}

export function slaDueDates(priority: keyof Settings['sla'], sla: Settings['sla'], from = new Date()) {
  const t = sla[priority];
  return {
    firstResponseDue: new Date(from.getTime() + t.firstResponseHours * 3600_000),
    resolutionDue: new Date(from.getTime() + t.resolutionHours * 3600_000),
  };
}
