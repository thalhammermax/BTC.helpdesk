/**
 * Pure keyword-matching logic for auto-assignment rules (no database access).
 *
 * Keyword syntax:
 *   printer          – matches the word "printer"
 *   "out of office"  – phrases are fine, quotes optional
 *   print*           – trailing * matches any word starting with "print" (printer, printing…)
 *   /vpn|remote/     – a value wrapped in slashes is treated as a regular expression
 * Matching is case-insensitive. With wholeWord=false, keywords match anywhere (e.g. "pass" in "password").
 */
export type MatchField = 'SUBJECT' | 'DESCRIPTION' | 'BOTH';
export type MatchMode = 'ANY' | 'ALL';

export interface RuleLike {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  matchField: MatchField;
  matchMode: MatchMode;
  keywords: string[];
  excludeKeywords?: string[];
  wholeWord: boolean;
  assignTeamId?: string | null;
  assignAgentId?: string | null;
  setPriority?: string | null;
  setCategoryId?: string | null;
  addTags?: string[];
  stopProcessing: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B_START = '(?<![\\p{L}\\p{N}_])';
const B_END = '(?![\\p{L}\\p{N}_])';

export function keywordToRegex(raw: string, wholeWord: boolean): RegExp | null {
  let kw = raw.trim();
  if (!kw) return null;
  const re = /^\/(.+)\/$/.exec(kw);
  if (re) {
    try {
      return new RegExp(re[1], 'iu');
    } catch {
      return null;
    }
  }
  kw = kw.replace(/^["']|["']$/g, '').trim();
  if (!kw) return null;
  const prefix = kw.endsWith('*');
  if (prefix) kw = kw.slice(0, -1);
  // Collapse whitespace in phrases so "out  of\noffice" still matches
  const body = kw.split(/\s+/).map(escape).join('\\s+');
  const tail = prefix ? '[\\p{L}\\p{N}_]*' : '';
  const source = wholeWord ? `${B_START}${body}${tail}${prefix ? '' : B_END}` : `${body}${tail}`;
  return new RegExp(source, 'iu');
}

export interface MatchResult {
  matched: boolean;
  hits: string[];
}

export function evaluateRule(rule: RuleLike, subject: string, description: string): MatchResult {
  if (!rule.enabled) return { matched: false, hits: [] };
  const text =
    rule.matchField === 'SUBJECT' ? subject : rule.matchField === 'DESCRIPTION' ? description : `${subject}\n${description}`;

  for (const ex of rule.excludeKeywords ?? []) {
    const r = keywordToRegex(ex, rule.wholeWord);
    if (r && r.test(text)) return { matched: false, hits: [] };
  }
  const keywords = rule.keywords.map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) return { matched: false, hits: [] };

  const hits: string[] = [];
  for (const kw of keywords) {
    const r = keywordToRegex(kw, rule.wholeWord);
    if (r && r.test(text)) hits.push(kw);
  }
  const matched = rule.matchMode === 'ALL' ? hits.length === keywords.length : hits.length > 0;
  return { matched, hits: matched ? hits : [] };
}

export interface RuleOutcome {
  teamId?: string;
  agentId?: string;
  priority?: string;
  categoryId?: string;
  tags: string[];
  matchedRules: { id: string; name: string; hits: string[] }[];
}

/**
 * Run all rules in order. The first matching rule to set a given field wins;
 * tags from every matching rule are combined. A rule with stopProcessing ends evaluation.
 */
export function runRules(rules: RuleLike[], subject: string, description: string): RuleOutcome {
  const out: RuleOutcome = { tags: [], matchedRules: [] };
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    const { matched, hits } = evaluateRule(rule, subject, description);
    if (!matched) continue;
    out.matchedRules.push({ id: rule.id, name: rule.name, hits });
    if (!out.teamId && !out.agentId) {
      if (rule.assignTeamId) out.teamId = rule.assignTeamId;
      if (rule.assignAgentId) out.agentId = rule.assignAgentId;
    }
    if (!out.priority && rule.setPriority) out.priority = rule.setPriority;
    if (!out.categoryId && rule.setCategoryId) out.categoryId = rule.setCategoryId;
    for (const t of rule.addTags ?? []) if (!out.tags.includes(t)) out.tags.push(t);
    if (rule.stopProcessing) break;
  }
  return out;
}

/** Choose an agent from a team. `candidates` must be sorted in a stable order. */
export function pickAgent(
  strategy: 'NONE' | 'ROUND_ROBIN' | 'LEAST_LOADED',
  candidates: { id: string; openTickets: number }[],
  lastAssignedId?: string | null,
): string | undefined {
  if (!candidates.length || strategy === 'NONE') return undefined;
  const nextAfter = (list: { id: string }[]) => {
    const idx = list.findIndex((c) => c.id === lastAssignedId);
    return list[(idx + 1) % list.length].id;
  };
  if (strategy === 'ROUND_ROBIN') return nextAfter(candidates);
  const min = Math.min(...candidates.map((c) => c.openTickets));
  const lowest = candidates.filter((c) => c.openTickets === min);
  // tie-break by round-robin order among the least-loaded agents
  if (lastAssignedId && lowest.some((c) => c.id === lastAssignedId) && lowest.length > 1) return nextAfter(lowest);
  const after = candidates.findIndex((c) => c.id === lastAssignedId);
  const rotated = [...candidates.slice(after + 1), ...candidates.slice(0, after + 1)];
  return rotated.find((c) => c.openTickets === min)!.id;
}
