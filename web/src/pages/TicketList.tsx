import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ago, api, label, PRIORITIES, STATUSES, type Team, type Ticket, type User } from '../api';
import { useMe } from '../App';
import { ErrorBox, Prio, StatusBadge, useLoad } from '../components/ui';

const TITLES: Record<string, string> = {
  mine: 'Assigned to me', unassigned: 'Unassigned', myteams: 'My teams', overdue: 'Overdue', all: 'All tickets', requested: 'My requests',
};

export default function TicketList() {
  const { me } = useMe();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? (me.isAgent ? 'mine' : 'requested');
  const [selected, setSelected] = useState<number[]>([]);
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = useMemo(() => {
    const p = new URLSearchParams(params);
    p.set('view', view);
    return p.toString();
  }, [params, view]);

  const { data, error, reload } = useLoad(() => api<{ items: Ticket[]; total: number; page: number; pageSize: number }>(`/tickets?${query}`), [query]);
  const { data: teams } = useLoad(() => (me.isAgent ? api<Team[]>('/teams') : Promise.resolve([])));
  const { data: agents } = useLoad(() => (me.isAgent ? api<User[]>('/users?role=AGENT,ADMIN') : Promise.resolve([])));

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    p.delete('page');
    setParams(p);
    setSelected([]);
  };
  const bulk = async (patch: Record<string, unknown>) => {
    await api('/tickets/bulk', { json: { ids: selected, patch } });
    setSelected([]);
    reload();
  };
  const page = Number(params.get('page') ?? 1);
  const goPage = (n: number) => { const p = new URLSearchParams(params); p.set('page', String(n)); setParams(p); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const sort = params.get('sort') ?? 'updatedAt';
  const order = params.get('order') ?? 'desc';
  const sortBy = (k: string) => {
    const p = new URLSearchParams(params);
    p.set('sort', k);
    p.set('order', sort === k && order === 'desc' ? 'asc' : 'desc');
    setParams(p);
  };
  const Th = ({ k, children }: { k: string; children: string }) => (
    <th style={{ cursor: 'pointer' }} onClick={() => sortBy(k)}>{children}{sort === k ? (order === 'desc' ? ' ↓' : ' ↑') : ''}</th>
  );

  return (
    <>
      <div className="topline">
        <h1>{me.isAgent ? TITLES[view] : 'My tickets'}</h1>
        <Link to="/tickets/new" className="btn primary">+ New ticket</Link>
      </div>
      <div className="filters">
        <form onSubmit={(e) => { e.preventDefault(); set('q', q); }} style={{ display: 'contents' }}>
          <input type="search" placeholder="Search subject, description, requester, #id…" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <select value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">{['mine', 'unassigned', 'myteams'].includes(view) ? 'Open statuses' : 'Any status'}</option>
          <option value="NEW,OPEN,PENDING,ON_HOLD">All open</option>
          {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select value={params.get('priority') ?? ''} onChange={(e) => set('priority', e.target.value)} aria-label="Priority">
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
        </select>
        {me.isAgent && (
          <>
            <select value={params.get('teamId') ?? ''} onChange={(e) => set('teamId', e.target.value)} aria-label="Team">
              <option value="">Any team</option>
              {teams?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {view === 'all' && (
              <select value={params.get('assigneeId') ?? ''} onChange={(e) => set('assigneeId', e.target.value)} aria-label="Assignee">
                <option value="">Any assignee</option>
                <option value="none">Unassigned</option>
                {agents?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </>
        )}
      </div>

      {me.isAgent && selected.length > 0 && (
        <div className="bulkbar">
          <strong>{selected.length} selected</strong>
          <button className="btn sm" onClick={() => bulk({ assigneeId: me.id })}>Assign to me</button>
          <select className="btn sm" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && bulk({ assigneeId: e.target.value })}>
            <option value="">Assign to…</option>
            {agents?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className="btn sm" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && bulk({ status: e.target.value })}>
            <option value="">Set status…</option>
            {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
          <select className="btn sm" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && bulk({ priority: e.target.value })}>
            <option value="">Set priority…</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
          </select>
          <button className="btn sm" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="list">
          <thead>
            <tr>
              {me.isAgent && (
                <th style={{ width: 30 }}>
                  <input type="checkbox" aria-label="Select all" checked={!!data?.items.length && selected.length === data.items.length}
                    onChange={(e) => setSelected(e.target.checked ? data!.items.map((t) => t.id) : [])} />
                </th>
              )}
              <Th k="id">#</Th>
              <th>Subject</th>
              {me.isAgent && <th>Requester</th>}
              <th>Status</th>
              <Th k="priority">Priority</Th>
              {me.isAgent && <th>Assignee</th>}
              {me.isAgent && <Th k="resolutionDue">Due</Th>}
              <Th k="updatedAt">Updated</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((t) => {
              const overdue = t.resolutionDue && new Date(t.resolutionDue) < new Date() && !['RESOLVED', 'CLOSED'].includes(t.status);
              return (
                <tr key={t.id} className="clickable" onClick={() => nav(`/tickets/${t.id}`)}>
                  {me.isAgent && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ticket ${t.id}`} checked={selected.includes(t.id)}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, t.id] : selected.filter((x) => x !== t.id))} />
                    </td>
                  )}
                  <td className="muted">{t.id}</td>
                  <td>
                    <Link to={`/tickets/${t.id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--text)', fontWeight: 500 }}>{t.subject}</Link>
                    <div className="small muted">
                      {t.team?.name ?? ''}{t.category ? ` · ${t.category.name}` : ''}{' '}
                      {t.tags.map((g) => <span key={g} className="tag">{g}</span>)}
                    </div>
                  </td>
                  {me.isAgent && <td><div>{t.requester.name}</div><div className="small muted">{t.requester.email}</div></td>}
                  <td><StatusBadge s={t.status} /></td>
                  <td><Prio p={t.priority} /></td>
                  {me.isAgent && <td>{t.assignee?.name ?? <span className="muted">—</span>}</td>}
                  {me.isAgent && <td className={overdue ? 'overdue' : 'muted'}>{['RESOLVED', 'CLOSED'].includes(t.status) ? '—' : ago(t.resolutionDue)}</td>}
                  <td className="muted">{ago(t.updatedAt)}</td>
                </tr>
              );
            })}
            {data?.items.length === 0 && (
              <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 30 }}>No tickets here.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data && (
        <div className="pager">
          <span>{data.total} ticket{data.total === 1 ? '' : 's'}</span>
          <span className="row">
            <button className="btn sm" disabled={page <= 1} onClick={() => goPage(page - 1)}>Previous</button>
            Page {page} of {pages}
            <button className="btn sm" disabled={page >= pages} onClick={() => goPage(page + 1)}>Next</button>
          </span>
        </div>
      )}
    </>
  );
}
