import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, label, PRIORITIES, type Category, type Team, type Ticket, type User } from '../api';
import { useMe } from '../App';
import { ErrorBox, useLoad } from '../components/ui';

export default function NewTicket() {
  const { me } = useMe();
  const nav = useNavigate();
  const { data: cats } = useLoad(() => api<Category[]>('/categories'));
  const { data: teams } = useLoad(() => (me.isAgent ? api<Team[]>('/teams') : Promise.resolve([])));
  const { data: agents } = useLoad(() => (me.isAgent ? api<User[]>('/users?role=AGENT,ADMIN') : Promise.resolve([])));
  const [f, setF] = useState({ subject: '', description: '', priority: 'NORMAL', categoryId: '', requesterEmail: '', teamId: '', assigneeId: '', cc: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const form = new FormData();
      Object.entries(f).forEach(([k, v]) => v && form.set(k, v));
      files.forEach((x) => form.append('files', x));
      const t = await api<Ticket>('/tickets', { form });
      nav(`/tickets/${t.id}`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <form className="card stack" style={{ maxWidth: 760 }} onSubmit={submit}>
      <h1>New ticket</h1>
      <ErrorBox error={err} />
      {me.isAgent && (
        <label className="field">Requester email (leave empty to create for yourself)
          <input type="email" value={f.requesterEmail} onChange={up('requesterEmail')} placeholder="user@company.com" />
        </label>
      )}
      <label className="field">Subject<input required value={f.subject} onChange={up('subject')} placeholder="Short summary of the problem" /></label>
      <label className="field">Description
        <textarea required rows={8} value={f.description} onChange={up('description')} placeholder="What happened? What did you expect? Any error messages?" />
      </label>
      <div className="grid2">
        <label className="field">Priority
          <select value={f.priority} onChange={up('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}</select>
        </label>
        <label className="field">Category
          <select value={f.categoryId} onChange={up('categoryId')}>
            <option value="">— choose —</option>
            {cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {me.isAgent && (
          <>
            <label className="field">Team (empty = auto-assign rules)
              <select value={f.teamId} onChange={up('teamId')}>
                <option value="">Auto</option>
                {teams?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="field">Assignee (empty = auto-assign rules)
              <select value={f.assigneeId} onChange={up('assigneeId')}>
                <option value="">Auto</option>
                {agents?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </>
        )}
      </div>
      <label className="field">CC (comma separated emails)<input value={f.cc} onChange={up('cc')} placeholder="colleague@company.com" /></label>
      <div className="row">
        <label className="btn">📎 Add attachments<input type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} /></label>
        {files.map((x, i) => <span key={i} className="chip">{x.name}<button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={() => nav(-1)}>Cancel</button>
        <button className="btn primary" disabled={busy}>Submit ticket</button>
      </div>
    </form>
  );
}
