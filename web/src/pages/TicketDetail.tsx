import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ago, api, fmtDate, fmtSize, label, PRIORITIES, STATUSES, type Category, type Status, type Team, type Ticket, type TicketEvent, type User } from '../api';
import { useMe } from '../App';
import { Chips, ErrorBox, Modal, Prio, StatusBadge, useLoad } from '../components/ui';

export default function TicketDetail() {
  const { id } = useParams();
  const { me } = useMe();
  const { data: t, error, reload } = useLoad(() => api<Ticket>(`/tickets/${id}`), [id]);
  const { data: teams } = useLoad(() => (me.isAgent ? api<Team[]>('/teams') : Promise.resolve([])));
  const { data: agents } = useLoad(() => (me.isAgent ? api<User[]>('/users?role=AGENT,ADMIN') : Promise.resolve([])));
  const { data: cats } = useLoad(() => api<Category[]>('/categories'));
  const [err, setErr] = useState<string>();

  if (error) return <ErrorBox error={error} />;
  if (!t) return <div className="muted">Loading…</div>;

  const patch = async (p: Record<string, unknown>) => {
    try { setErr(undefined); await api(`/tickets/${t.id}`, { method: 'PATCH', json: p }); reload(); }
    catch (e) { setErr((e as Error).message); }
  };
  const name = (uid?: unknown) => agents?.find((a) => a.id === uid)?.name ?? teams?.find((x) => x.id === uid)?.name ?? cats?.find((c) => c.id === uid)?.name ?? (uid ? String(uid) : 'none');
  const overdue = t.resolutionDue && new Date(t.resolutionDue) < new Date() && !['RESOLVED', 'CLOSED'].includes(t.status);

  return (
    <>
      <div className="topline">
        <div>
          <div className="small muted"><Link to="/tickets">Tickets</Link> / #{t.id}</div>
          <h1 style={{ marginTop: 4 }}>{t.subject}</h1>
          <div className="row small muted">
            <StatusBadge s={t.status} /> <Prio p={t.priority} /> · via {label(t.channel)} · opened {ago(t.createdAt)} by {t.requester.name}
          </div>
        </div>
        {!me.isAgent && t.requester.id === me.id && (
          ['RESOLVED', 'CLOSED'].includes(t.status)
            ? t.status === 'RESOLVED' && <button className="btn" onClick={() => api(`/tickets/${t.id}/status`, { json: { status: 'OPEN' } }).then(reload)}>Reopen</button>
            : <button className="btn" onClick={() => api(`/tickets/${t.id}/status`, { json: { status: 'RESOLVED' } }).then(reload)}>Mark as resolved</button>
        )}
      </div>
      <ErrorBox error={err} />
      <div className="ticket-layout">
        <div className="conv">
          {t.sourceUrl && <div className="small muted">Submitted from: <a href={t.sourceUrl} target="_blank" rel="noreferrer">{t.sourceUrl}</a></div>}
          {t.messages?.map((m) => {
            const staff = m.author && m.author.role !== 'REQUESTER';
            return (
              <div key={m.id} className={`msg ${m.internal ? 'internal' : staff ? 'staff' : ''}`}>
                <div className="msg-head">
                  <span><strong>{m.author?.name ?? 'System'}</strong>{m.internal && ' · internal note'}{m.author && ` · ${m.author.email}`}</span>
                  <span title={fmtDate(m.createdAt)}>{ago(m.createdAt)} · {label(m.channel)}</span>
                </div>
                <div className="msg-body">{m.body}</div>
                {m.attachments.length > 0 && (
                  <div className="atts">
                    {m.attachments.map((a) => (
                      <a key={a.id} className="att" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">
                        {a.contentType.startsWith('image/') ? <img src={`/api/attachments/${a.id}`} alt={a.filename} /> : '📎'}
                        <span>{a.filename} <span className="muted">({fmtSize(a.size)})</span></span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {t.status !== 'CLOSED' || me.isAgent ? <Composer ticket={t} onSent={reload} /> : <div className="card muted">This ticket is closed. Create a new ticket if you need more help.</div>}
        </div>

        <aside className="props">
          {me.isAgent ? (
            <div className="card stack">
              <label className="field">Status
                <select value={t.status} onChange={(e) => patch({ status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                </select>
              </label>
              <label className="field">Priority
                <select value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
                </select>
              </label>
              <label className="field">Team
                <select value={t.teamId ?? ''} onChange={(e) => patch({ teamId: e.target.value || null })}>
                  <option value="">— none —</option>
                  {teams?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
              <label className="field">Assignee
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <select value={t.assigneeId ?? ''} onChange={(e) => patch({ assigneeId: e.target.value || null })}>
                    <option value="">— unassigned —</option>
                    {agents?.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}{a.available ? '' : ' (away)'}</option>)}
                  </select>
                  {t.assigneeId !== me.id && <button className="btn sm" onClick={() => patch({ assigneeId: me.id })}>Take</button>}
                </div>
              </label>
              <label className="field">Category
                <select value={t.categoryId ?? ''} onChange={(e) => patch({ categoryId: e.target.value || null })}>
                  <option value="">— none —</option>
                  {cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <div className="field" style={{ fontSize: 12, color: 'var(--text-2)' }}>Tags
                <Chips value={t.tags} onChange={(tags) => patch({ tags })} placeholder="Add tag…" />
              </div>
            </div>
          ) : null}
          <div className="card">
            <h3>Details</h3>
            <dl>
              <dt>Requester</dt><dd>{t.requester.name}<br /><span className="small muted">{t.requester.email}</span></dd>
              {!me.isAgent && <><dt>Assignee</dt><dd>{t.assignee?.name ?? 'Not yet assigned'}</dd></>}
              {t.category && !me.isAgent && <><dt>Category</dt><dd>{t.category.name}</dd></>}
              <dt>Created</dt><dd>{fmtDate(t.createdAt)}</dd>
              {me.isAgent && (
                <>
                  <dt>1st response</dt>
                  <dd>{t.firstResponseAt ? fmtDate(t.firstResponseAt) : <span className={t.firstResponseDue && new Date(t.firstResponseDue) < new Date() ? 'overdue' : ''}>due {ago(t.firstResponseDue)}</span>}</dd>
                  <dt>Resolve by</dt>
                  <dd className={overdue ? 'overdue' : ''}>{t.resolvedAt ? `resolved ${fmtDate(t.resolvedAt)}` : `${fmtDate(t.resolutionDue)} (${ago(t.resolutionDue)})`}</dd>
                  {t.autoAssignedRule && <><dt>Auto-rule</dt><dd>{t.autoAssignedRule}</dd></>}
                </>
              )}
            </dl>
          </div>
          <Watchers t={t} onChange={reload} />
          {me.isAgent && <MergeBox t={t} />}
          {me.isAgent && t.events && (
            <div className="card">
              <h3>History</h3>
              <div className="timeline">
                {t.events.map((e) => <div key={e.id}><span className="muted">{ago(e.createdAt)}</span> · {describe(e, name)}</div>)}
              </div>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function describe(e: TicketEvent, name: (id?: unknown) => string) {
  const who = e.actor?.name ?? 'System';
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'created': return `${who} created the ticket via ${label(String(d.channel ?? 'web'))}`;
    case 'auto_assigned': {
      const rules = (d.rules as { name: string; hits: string[] }[] | undefined) ?? [];
      const why = rules.length ? `rule${rules.length > 1 ? 's' : ''} ${rules.map((r) => `"${r.name}" (${r.hits.join(', ')})`).join(', ')}` : 'default team';
      return `Auto-assigned to ${d.assigneeId ? name(d.assigneeId) : name(d.teamId)} by ${why}`;
    }
    case 'status': return `${who} changed status ${label(String(d.from))} → ${label(String(d.to))}${d.reason ? ` (${d.reason})` : ''}`;
    case 'priority': return `${who} changed priority ${label(String(d.from))} → ${label(String(d.to))}`;
    case 'assignee': return `${who} assigned to ${d.to ? name(d.to) : 'nobody'}`;
    case 'team': return `${who} moved to team ${d.to ? name(d.to) : 'none'}`;
    case 'category': return `${who} set category ${d.to ? name(d.to) : 'none'}`;
    case 'tags': return `${who} changed tags`;
    case 'watcher_added': return `${who} added CC ${d.email}`;
    case 'merged': return `${who} merged this ticket into #${d.into}`;
    case 'merged_from': return `${who} merged #${d.from} into this ticket`;
    case 'follow_up_of': return `Follow-up of closed ticket #${d.ticketId}`;
    case 'subject': return `${who} renamed the ticket`;
    default: return `${who}: ${e.type}`;
  }
}

function Composer({ ticket, onSent }: { ticket: Ticket; onSent: () => void }) {
  const { me } = useMe();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<Status | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const { data: canned } = useLoad(() => (me.isAgent ? api<{ id: string; title: string; body: string }[]>('/canned') : Promise.resolve([])));

  const send = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const f = new FormData();
      f.set('body', body);
      f.set('internal', String(mode === 'note'));
      if (status) f.set('status', status);
      files.forEach((x) => f.append('files', x));
      await api(`/tickets/${ticket.id}/messages`, { form: f });
      setBody(''); setFiles([]); setStatus('');
      onSent();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={`composer ${mode === 'note' ? 'internal' : ''}`}>
      {me.isAgent && (
        <div className="tabs">
          <button className={mode === 'reply' ? 'active' : ''} onClick={() => setMode('reply')}>Reply to requester</button>
          <button className={mode === 'note' ? 'active' : ''} onClick={() => setMode('note')}>Internal note</button>
        </div>
      )}
      <textarea
        placeholder={mode === 'note' ? 'Only visible to agents…' : me.isAgent ? `Reply to ${ticket.requester.name} (sent by email)…` : 'Add a reply…'}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && body.trim()) send(); }}
      />
      {err && <div className="error" style={{ margin: 8 }}>{err}</div>}
      <div className="composer-foot">
        <div className="row">
          <label className="btn sm">📎 Attach<input type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} /></label>
          {files.map((f, i) => <span key={i} className="chip">{f.name}<button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}
          {me.isAgent && !!canned?.length && (
            <select className="btn sm" style={{ width: 'auto' }} value="" onChange={(e) => {
              const c = canned.find((x) => x.id === e.target.value);
              if (c) setBody(body ? `${body}\n\n${c.body}` : c.body);
            }}>
              <option value="">Insert canned response…</option>
              {canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          )}
        </div>
        <div className="row">
          {me.isAgent && (
            <select className="btn sm" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label="Status after sending">
              <option value="">{mode === 'reply' ? 'Status: auto (Pending)' : 'Keep status'}</option>
              {STATUSES.map((s) => <option key={s} value={s}>Set {label(s)}</option>)}
            </select>
          )}
          <button className="btn primary" disabled={busy || !body.trim()} onClick={send}>{mode === 'note' ? 'Add note' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}

function Watchers({ t, onChange }: { t: Ticket; onChange: () => void }) {
  const [email, setEmail] = useState('');
  const add = async () => { await api(`/tickets/${t.id}/watchers`, { json: { email } }); setEmail(''); onChange(); };
  return (
    <div className="card">
      <h3>CC / watchers</h3>
      <div className="stack" style={{ gap: 6 }}>
        {t.watchers?.length === 0 && <span className="muted small">No one else is copied.</span>}
        {t.watchers?.map((w) => (
          <div key={w.user.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span className="small">{w.user.email}</span>
            <button className="btn sm" onClick={() => api(`/tickets/${t.id}/watchers/${w.user.id}`, { method: 'DELETE' }).then(onChange)}>×</button>
          </div>
        ))}
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn sm" disabled={!email.includes('@')} onClick={add}>Add</button>
        </div>
      </div>
    </div>
  );
}

function MergeBox({ t }: { t: Ticket }) {
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState('');
  const [err, setErr] = useState<string>();
  const merge = async () => {
    try { await api(`/tickets/${t.id}/merge`, { json: { intoId: Number(into) } }); window.location.href = `/tickets/${into}`; }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>Merge into another ticket…</button>
      {open && (
        <Modal title={`Merge #${t.id}`} onClose={() => setOpen(false)} footer={<>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" disabled={!into} onClick={merge}>Merge</button>
        </>}>
          <p className="muted">All messages and attachments move to the target ticket. This ticket will be closed.</p>
          <ErrorBox error={err} />
          <label className="field">Target ticket number<input type="number" value={into} onChange={(e) => setInto(e.target.value)} /></label>
        </Modal>
      )}
    </>
  );
}
