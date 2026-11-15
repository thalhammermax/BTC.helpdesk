import { useEffect, useState } from 'react';
import { api, label, PRIORITIES, type Team } from '../../api';
import { ErrorBox, useLoad } from '../../components/ui';

interface S {
  defaultTeamId: string | null; autoCloseDays: number; sendAcknowledgement: boolean; reopenOnReply: boolean; helpdeskName: string;
  sla: Record<string, { firstResponseHours: number; resolutionHours: number }>;
}
export default function SettingsPage() {
  const { data, error } = useLoad(() => api<S>('/settings'));
  const { data: teams } = useLoad(() => api<Team[]>('/teams'));
  const [s, setS] = useState<S>();
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();
  useEffect(() => { if (data) setS(data); }, [data]);
  if (!s) return <ErrorBox error={error} />;
  const sla = (p: string, k: 'firstResponseHours' | 'resolutionHours', v: string) => setS({ ...s, sla: { ...s.sla, [p]: { ...s.sla[p], [k]: Number(v) } } });
  const save = async () => {
    try { setErr(undefined); setS(await api<S>('/settings', { method: 'PUT', json: s })); setMsg('Saved'); setTimeout(() => setMsg(undefined), 2000); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Settings &amp; SLA</h1>
      <ErrorBox error={err} />
      <div className="card stack">
        <h2 style={{ margin: 0 }}>General</h2>
        <label className="field">Help desk name<input value={s.helpdeskName} onChange={(e) => setS({ ...s, helpdeskName: e.target.value })} /></label>
        <label className="field">Default team (when no auto-assign rule matches)
          <select value={s.defaultTeamId ?? ''} onChange={(e) => setS({ ...s, defaultTeamId: e.target.value || null })}>
            <option value="">— leave unassigned —</option>
            {teams?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">Auto-close resolved tickets after (days, 0 = never)
          <input type="number" min={0} value={s.autoCloseDays} onChange={(e) => setS({ ...s, autoCloseDays: Number(e.target.value) })} />
        </label>
        <label className="check"><input type="checkbox" checked={s.sendAcknowledgement} onChange={(e) => setS({ ...s, sendAcknowledgement: e.target.checked })} /> Email the requester an acknowledgement with the ticket number</label>
        <label className="check"><input type="checkbox" checked={s.reopenOnReply} onChange={(e) => setS({ ...s, reopenOnReply: e.target.checked })} /> Reopen resolved tickets when the requester replies</label>
      </div>
      <div className="card">
        <h2>SLA targets (hours, calendar time)</h2>
        <table className="list">
          <thead><tr><th>Priority</th><th>First response</th><th>Resolution</th></tr></thead>
          <tbody>
            {[...PRIORITIES].reverse().map((p) => (
              <tr key={p}>
                <td>{label(p)}</td>
                <td><input type="number" min={0.25} step={0.25} value={s.sla[p].firstResponseHours} onChange={(e) => sla(p, 'firstResponseHours', e.target.value)} /></td>
                <td><input type="number" min={0.25} step={0.25} value={s.sla[p].resolutionHours} onChange={(e) => sla(p, 'resolutionHours', e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row"><button className="btn primary" onClick={save}>Save settings</button>{msg && <span className="muted">{msg}</span>}</div>
    </div>
  );
}
