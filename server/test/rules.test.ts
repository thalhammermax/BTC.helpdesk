import { describe, expect, it } from 'vitest';
import { evaluateRule, keywordToRegex, pickAgent, runRules, type RuleLike } from '../src/services/rules.js';

const rule = (over: Partial<RuleLike>): RuleLike => ({
  id: over.name ?? 'r',
  name: 'r',
  enabled: true,
  position: 0,
  matchField: 'BOTH',
  matchMode: 'ANY',
  keywords: [],
  wholeWord: true,
  stopProcessing: true,
  ...over,
});

describe('keyword matching', () => {
  it('matches whole words case-insensitively', () => {
    const r = keywordToRegex('printer', true)!;
    expect(r.test('My PRINTER is jammed')).toBe(true);
    expect(r.test('printers are broken')).toBe(false);
  });
  it('supports prefix wildcards', () => {
    const r = keywordToRegex('print*', true)!;
    expect(r.test('printing fails')).toBe(true);
    expect(r.test('blueprint')).toBe(false);
  });
  it('supports phrases with flexible whitespace', () => {
    expect(keywordToRegex('"out of office"', true)!.test('I am out  of\noffice')).toBe(true);
  });
  it('supports substring mode', () => {
    expect(keywordToRegex('pass', false)!.test('reset my password')).toBe(true);
    expect(keywordToRegex('pass', true)!.test('reset my password')).toBe(false);
  });
  it('supports regex keywords and survives invalid ones', () => {
    expect(keywordToRegex('/vpn|remote access/', true)!.test('Remote Access down')).toBe(true);
    expect(keywordToRegex('/[unclosed/', true)).toBeNull();
  });
  it('escapes special characters', () => {
    expect(keywordToRegex('c++', false)!.test('c++ compiler')).toBe(true);
    expect(keywordToRegex('a.b', true)!.test('axb')).toBe(false);
  });
  it('handles non-ASCII words', () => {
    expect(keywordToRegex('drucker', true)!.test('Der Drucker geht nicht')).toBe(true);
    expect(keywordToRegex('café', true)!.test('café machine')).toBe(true);
  });
});

describe('evaluateRule', () => {
  it('respects match field', () => {
    const r = rule({ keywords: ['vpn'], matchField: 'SUBJECT' });
    expect(evaluateRule(r, 'hello', 'vpn broken').matched).toBe(false);
    expect(evaluateRule(r, 'VPN broken', '').matched).toBe(true);
  });
  it('ALL requires every keyword', () => {
    const r = rule({ keywords: ['laptop', 'screen'], matchMode: 'ALL' });
    expect(evaluateRule(r, 'laptop', 'nothing').matched).toBe(false);
    expect(evaluateRule(r, 'laptop', 'the screen flickers').matched).toBe(true);
  });
  it('exclude keywords veto a match', () => {
    const r = rule({ keywords: ['invoice'], excludeKeywords: ['newsletter'] });
    expect(evaluateRule(r, 'invoice', '').matched).toBe(true);
    expect(evaluateRule(r, 'invoice newsletter', '').matched).toBe(false);
  });
  it('disabled rules never match', () => {
    expect(evaluateRule(rule({ keywords: ['x'], enabled: false }), 'x', '').matched).toBe(false);
  });
});

describe('runRules', () => {
  const rules = [
    rule({ name: 'tags', position: 0, keywords: ['urgent', 'asap'], setPriority: 'URGENT', addTags: ['escalated'], stopProcessing: false }),
    rule({ name: 'network', position: 1, keywords: ['vpn', 'wifi'], assignTeamId: 'net', addTags: ['network'] }),
    rule({ name: 'hardware', position: 2, keywords: ['laptop'], assignTeamId: 'hw' }),
  ];
  it('applies rules in order and stops when told to', () => {
    const o = runRules(rules, 'URGENT: VPN and laptop broken', '');
    expect(o.teamId).toBe('net');
    expect(o.priority).toBe('URGENT');
    expect(o.tags).toEqual(['escalated', 'network']);
    expect(o.matchedRules.map((r) => r.name)).toEqual(['tags', 'network']);
  });
  it('sorts by position regardless of input order', () => {
    const o = runRules([...rules].reverse(), 'vpn laptop', '');
    expect(o.teamId).toBe('net');
  });
  it('returns nothing when no rule matches', () => {
    const o = runRules(rules, 'Hello', 'Question about payroll');
    expect(o.matchedRules).toHaveLength(0);
    expect(o.teamId).toBeUndefined();
  });
});

describe('pickAgent', () => {
  const c = [
    { id: 'a', openTickets: 3 },
    { id: 'b', openTickets: 1 },
    { id: 'c', openTickets: 1 },
  ];
  it('round robin rotates', () => {
    expect(pickAgent('ROUND_ROBIN', c, null)).toBe('a');
    expect(pickAgent('ROUND_ROBIN', c, 'a')).toBe('b');
    expect(pickAgent('ROUND_ROBIN', c, 'c')).toBe('a');
  });
  it('least loaded picks fewest open tickets and rotates ties', () => {
    expect(pickAgent('LEAST_LOADED', c, null)).toBe('b');
    expect(pickAgent('LEAST_LOADED', c, 'b')).toBe('c');
    expect(pickAgent('LEAST_LOADED', c, 'c')).toBe('b');
  });
  it('NONE and empty return undefined', () => {
    expect(pickAgent('NONE', c, null)).toBeUndefined();
    expect(pickAgent('ROUND_ROBIN', [], null)).toBeUndefined();
  });
});
