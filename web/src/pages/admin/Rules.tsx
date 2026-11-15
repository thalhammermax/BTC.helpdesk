import { useState } from 'react';
import { api, label, PRIORITIES, type Category, type Rule, type Team, type User } from '../../api';
import { Chips, ErrorBox, Modal, useLoad } from '../../components/ui';

type Draft = Omit<Rule, 'id' | 'position' | 'hitCount' | 'team' | 'agent' | 'category'> & { id?: string };
const blank: Draft = {
  name: '', enabled: true, matchField: 'BOTH', matchMode: 'ANY', keywords: [], excludeKeywords: [], wholeWord: true,
  assignTeamId: null, assignAgentId: null, setPriority: null, setCategoryId: null, addTags: [], stopProcessing: true,
};

export default function Rules() {
  const { data: rules, error, reload } = useLoad(() => api<Rule[]>('/rules'));
  const { data: teams } = useLoad(() => api<Team[]>('/teams'));
  const { data: agents } = useLoad(() => api<User[]>('/users?role=AGENT,ADMIN'));
  const { data: cats } = useLoad(() => api<Category[]>('/categories'));
  const [edit, setEdit] = useState<Draft | null>(null);

  const move = async (i: number, d: -1 | 1) => {
    const ids = rules!.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await api('/rules/reorder', { json: { ids } });
    reload();
  };
  const toggle = async (r: Rule) => {
    const { id, position, hitCount, team, agent, category, ...rest } = r;
    void position; void hitCount; void team; void agent; void category;
    await api(`/rules/${id}`, { method: 'PUT', json: { ...rest, enabled: !r.enabled } });
    reload();
  };
  const action = (r: Rule) =>
    [
      r.agent && `assign to ${r.agent.name}`,
      r.team && `${r.agent ? 'or ' : ''}route to ${r.team.name}`,
      r.setPriority && `priority ${label(r.setPriority)}`,
      r.category && `category ${r.category.name}`,
      r.addTags.length && `tag ${r.addTags.join(', ')}`,
    ].filter(Boolean).join(' · ') || '—';

  return (
    <>
      <div className="topline">
        <h1>Auto-assign rules</h1>
        <button className="btn primary" onClick={() => setEdit({ ...blank })}>+ New rule</button>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Every new ticket (email, web or Chrome extension) is checked against these rules from top to bottom. The first rule that sets a team or agent wins;
        a rule with <em>stop</em> ends evaluation. If nothing matches, the ticket goes to the default team (Settings).
      </p>
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="list">
          <thead><tr><th style={{ width: 70 }}>Order</th><th>Rule</th><th>When</th><th>Then</th><th>Hits</th><th>On</th><th /></tr></thead>
          <tbody>
            {rules?.map((r, i) => (
              <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.55 }}>
                <td>
                  <button className="btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>{' '}
                  <button className="btn sm" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                </td>
                <td><strong>{r.name}</strong>{r.stopProcessing ? '' : <div className="small muted">continues to next rule</div>}</td>
                <td className="small">
                  {label(r.matchField === 'BOTH' ? 'subject or description' : r.matchField)} contains <strong>{r.matchMode === 'ALL' ? 'all' : 'any'}</strong> of{' '}
                  {r.keywords.map((k) => <span key={k} className="tag">{k}</span>)}
                  {r.excludeKeywords.length > 0 && <> but not {r.excludeKeywords.map((k) => <span key={k} className="tag" style={{ textDecoration: 'line-through' }}>{k}</span>)}</>}
                </td>
                <td className="small">{action(r)}</td>
                <td className="muted">{r.hitCount}</td>
                <td><input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} aria-label="Enabled" /></td>
                <td>
                  <button className="btn sm" onClick={() => setEdit({ ...r })}>Edit</button>{' '}
                  <button className="btn sm danger" onClick={async () => { if (confirm(`Delete rule "${r.name}"?`)) { await api(`/rules/${r.id}`, { method: 'DELETE' }); reload(); } }}>Delete</button>
                </td>
              </tr>
            ))}
            {rules?.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <Tester />
      {edit && <RuleEditor draft={edit} teams={teams ?? []} agents={agents ?? []} cats={cats ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function RuleEditor({ draft, teams, agents, cats, onClose, onSaved }: { draft: Draft; teams: Team[]; agents: User[]; cats: Category[]; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<Draft>(draft);
  const [err, setErr] = useState<string>();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setR({ ...r, [k]: v });
  const save = async () => {
    const { id, ...body } = r;
    const clean = Object.fromEntries(Object.entries(body).filter(([k]) => !['position', 'hitCount', 'team', 'agent', 'category', 'createdAt', 'updatedAt'].includes(k)));
    try {
      await api(id ? `/rules/${id}` : '/rules', { method: id ? 'PUT' : 'POST', json: clean });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title={r.id ? 'Edit rule' : 'New rule'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save rule</button></>}>
      <div className="stack">
        <ErrorBox error={err} />
        <label className="field">Rule name<input value={r.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. VPN problems → Network team" /></label>
        <h3 style={{ margin: '6px 0 0' }}>When</h3>
        <div className="grid2">
          <label className="field">Look in
            <select value={r.matchField} onChange={(e) => set('matchField', e.target.value as Draft['matchField'])}>
              <option value="BOTH">Subject or description</option><option value="SUBJECT">Subject only</option><option value="DESCRIPTION">Description only</option>
            </select>
          </label>
          <label className="field">Match
            <select value={r.matchMode} onChange={(e) => set('matchMode', e.target.value as Draft['matchMode'])}>
              <option value="ANY">Any keyword</option><option value="ALL">All keywords</option>
            </select>
          </label>
        </div>
        <div className="field" style={{ fontSize: 12, color: 'var(--text-2)' }}>Keywords
          <Chips value={r.keywords} onChange={(v) => set('keywords', v)} placeholder="Type a keyword and press Enter" />
          <span className="hint">Case-insensitive. Phrases allowed. <code>print*</code> matches printer/printing. <code>/regex/</code> for advanced patterns.</span>
        </div>
        <div className="field" style={{ fontSize: 12, color: 'var(--text-2)' }}>Unless it contains (optional)
          <Chips variant="ex" value={r.excludeKeywords} onChange={(v) => set('excludeKeywords', v)} placeholder="e.g. newsletter" />
        </div>
        <label className="check"><input type="checkbox" checked={r.wholeWord} onChange={(e) => set('wholeWord', e.target.checked)} /> Whole words only (“pass” won’t match “password”)</label>
        <h3 style={{ margin: '6px 0 0' }}>Then</h3>
        <div className="grid2">
          <label className="field">Route to team
            <select value={r.assignTeamId ?? ''} onChange={(e) => set('assignTeamId', e.target.value || null)}>
              <option value="">— don’t change —</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({label(t.strategy)})</option>)}
            </select>
          </label>
          <label className="field">Assign to agent
            <select value={r.assignAgentId ?? ''} onChange={(e) => set('assignAgentId', e.target.value || null)}>
              <option value="">— pick from team automatically —</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="field">Set priority
            <select value={r.setPriority ?? ''} onChange={(e) => set('setPriority', (e.target.value || null) as Draft['setPriority'])}>
              <option value="">— don’t change —</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
            </select>
          </label>
          <label className="field">Set category
            <select value={r.setCategoryId ?? ''} onChange={(e) => set('setCategoryId', e.target.value || null)}>
              <option value="">— don’t change —</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="field" style={{ fontSize: 12, color: 'var(--text-2)' }}>Add tags<Chips value={r.addTags} onChange={(v) => set('addTags', v.map((x) => x.toLowerCase()))} placeholder="optional" /></div>
        <span className="hint">If the chosen agent is marked unavailable, the ticket goes to their team using the team’s strategy (round robin / least loaded).</span>
        <label className="check"><input type="checkbox" checked={r.stopProcessing} onChange={(e) => set('stopProcessing', e.target.checked)} /> Stop checking further rules when this one matches</label>
        <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled</label>
      </div>
    </Modal>
  );
}

function Tester() {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [res, setRes] = useState<{ matchedRules: { name: string; hits: string[] }[]; team?: { name: string; strategy: string }; agent?: { name: string; available: boolean }; priority?: string; category?: Category; tags: string[] } | null>(null);
  const run = async () => setRes(await api('/rules/test', { json: { subject, description } }));
  return (
    <div className="card stack" style={{ marginTop: 20 }}>
      <h2 style={{ margin: 0 }}>Test your rules</h2>
      <p className="hint" style={{ margin: 0 }}>Paste a sample subject / description to see which rules match. Nothing is saved.</p>
      <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div><button className="btn" onClick={run}>Run test</button></div>
      {res && (res.matchedRules.length === 0 ? (
        <div className="muted">No rules matched — the ticket would go to the default team.</div>
      ) : (
        <div className="rule-hit small">
          <div><strong>Matched:</strong> {res.matchedRules.map((m) => `${m.name} (${m.hits.join(', ')})`).join(' → ')}</div>
          {res.agent && <div>Agent: {res.agent.name}{res.agent.available ? '' : ' (unavailable → team fallback)'}</div>}
          {res.team && <div>Team: {res.team.name} — {label(res.team.strategy)}</div>}
          {res.priority && <div>Priority: {label(res.priority)}</div>}
          {res.category && <div>Category: {res.category.name}</div>}
          {res.tags.length > 0 && <div>Tags: {res.tags.join(', ')}</div>}
        </div>
      ))}
    </div>
  );
}
