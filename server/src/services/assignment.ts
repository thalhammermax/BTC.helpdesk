import type { Prisma, Priority } from '@prisma/client';
import { prisma } from '../db.js';
import { pickAgent, runRules, type RuleOutcome } from './rules.js';
import { getSetting } from './settings.js';

export const OPEN_STATUSES = ['NEW', 'OPEN', 'PENDING', 'ON_HOLD'] as const;

export async function loadRules() {
  return prisma.assignmentRule.findMany({ where: { enabled: true }, orderBy: { position: 'asc' } });
}

/** Pick an available agent from a team according to the team's strategy, and record it. */
export async function pickTeamAgent(teamId: string): Promise<string | undefined> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { members: { include: { user: true } } },
  });
  if (!team) return undefined;
  const members = team.members
    .map((m) => m.user)
    .filter((u) => u.active && u.available && u.role !== 'REQUESTER')
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!members.length) return undefined;
  const counts = await prisma.ticket.groupBy({
    by: ['assigneeId'],
    where: { assigneeId: { in: members.map((m) => m.id) }, status: { in: [...OPEN_STATUSES] } },
    _count: true,
  });
  const load = new Map(counts.map((c) => [c.assigneeId, c._count]));
  const agentId = pickAgent(
    team.strategy,
    members.map((m) => ({ id: m.id, openTickets: load.get(m.id) ?? 0 })),
    team.lastAssignedId,
  );
  if (agentId) await prisma.team.update({ where: { id: teamId }, data: { lastAssignedId: agentId } });
  return agentId;
}

export interface AssignmentDecision extends RuleOutcome {
  assigneeId?: string;
}

/** Evaluate rules against a new ticket and resolve team / agent. Does not write the ticket. */
export async function decideAssignment(subject: string, description: string): Promise<AssignmentDecision> {
  const outcome: AssignmentDecision = runRules(await loadRules(), subject, description);

  if (!outcome.teamId && !outcome.agentId) {
    const fallback = await getSetting('defaultTeamId');
    if (fallback) outcome.teamId = fallback;
  }
  if (outcome.agentId) {
    const agent = await prisma.user.findUnique({ where: { id: outcome.agentId } });
    if (agent?.active && agent.available && agent.role !== 'REQUESTER') outcome.assigneeId = agent.id;
    else if (!outcome.teamId) {
      // the named agent is unavailable: fall back to one of their teams
      const membership = await prisma.teamMember.findFirst({ where: { userId: outcome.agentId } });
      outcome.teamId = membership?.teamId;
    }
  }
  if (!outcome.assigneeId && outcome.teamId) outcome.assigneeId = await pickTeamAgent(outcome.teamId);
  return outcome;
}

export function decisionToTicketData(d: AssignmentDecision): Partial<Prisma.TicketUncheckedCreateInput> {
  return {
    ...(d.teamId ? { teamId: d.teamId } : {}),
    ...(d.assigneeId ? { assigneeId: d.assigneeId, status: 'OPEN' as const } : {}),
    ...(d.priority ? { priority: d.priority as Priority } : {}),
    ...(d.categoryId ? { categoryId: d.categoryId } : {}),
    ...(d.matchedRules[0] ? { autoAssignedRule: d.matchedRules.map((r) => r.name).join(', ') } : {}),
  };
}

export async function recordRuleHits(d: AssignmentDecision) {
  if (!d.matchedRules.length) return;
  await prisma.assignmentRule.updateMany({
    where: { id: { in: d.matchedRules.map((r) => r.id) } },
    data: { hitCount: { increment: 1 } },
  });
}
