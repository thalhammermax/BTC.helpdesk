import { Link } from 'react-router-dom';
import { api, label } from '../api';
import { ErrorBox, useLoad } from '../components/ui';

interface Stats {
  byStatus: Record<string, number>; byPriority: Record<string, number>; unassigned: number; overdue: number; mine: number;
  createdPerDay: { date: string; count: number }[]; channels: Record<string, number>; byTeam: { team: string; count: number }[];
  avgResolutionHours: number | null; avgFirstResponseHours: number | null;
}
const hrs = (h: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);

export default function Dashboard() {
  const { data: s, error } = useLoad(() => api<Stats>('/stats'));
  if (error) return <ErrorBox error={error} />;
  if (!s) return <div className="muted">Loading…</div>;
  const open = ['NEW', 'OPEN', 'PENDING', 'ON_HOLD'].reduce((a, k) => a + (s.byStatus[k] ?? 0), 0);
  const max = Math.max(1, ...s.createdPerDay.map((d) => d.count));
  const teamMax = Math.max(1, ...s.byTeam.map((t) => t.count));
  return (
    <>
      <h1>Dashboard</h1>
      <div className="tiles">
        <Link className="tile" to="/tickets?view=mine"><div className="k">Assigned to me</div><div className="v">{s.mine}</div></Link>
        <Link className="tile" to="/tickets?view=unassigned"><div className="k">Unassigned</div><div className="v">{s.unassigned}</div></Link>
        <Link className={`tile ${s.overdue ? 'alert' : ''}`} to="/tickets?view=overdue"><div className="k">Overdue (SLA)</div><div className="v">{s.overdue}</div></Link>
        <Link className="tile" to="/tickets?view=all&status=NEW,OPEN,PENDING,ON_HOLD"><div className="k">All open</div><div className="v">{open}</div></Link>
        <div className="tile"><div className="k">Avg first response (14d)</div><div className="v">{hrs(s.avgFirstResponseHours)}</div></div>
        <div className="tile"><div className="k">Avg resolution (14d)</div><div className="v">{hrs(s.avgResolutionHours)}</div></div>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Tickets created · last 14 days</h2>
          <div className="bars" role="img" aria-label="Tickets created per day">
            {s.createdPerDay.map((d) => (
              <div className="bar-col" key={d.date}>
                <span className="tip">{new Date(d.date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: {d.count}</span>
                <div className="bar" style={{ height: `${(d.count / max) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="bars-axis">
            {s.createdPerDay.map((d, i) => <span key={d.date}>{(s.createdPerDay.length - 1 - i) % 2 === 0 ? new Date(d.date + 'T00:00').getDate() : ''}</span>)}
          </div>
          <p className="hint">
            By channel: {Object.entries(s.channels).map(([k, v]) => `${label(k)} ${v}`).join(' · ') || 'no tickets yet'}
          </p>
        </div>
        <div className="card">
          <h2>Open tickets by team</h2>
          {s.byTeam.length === 0 && <p className="muted">No open tickets.</p>}
          {s.byTeam.sort((a, b) => b.count - a.count).map((t) => (
            <div className="hbar" key={t.team}>
              <span>{t.team}</span>
              <div className="track"><div className="fill" style={{ width: `${(t.count / teamMax) * 100}%` }} /></div>
              <span className="n">{t.count}</span>
            </div>
          ))}
          <h2 style={{ marginTop: 20 }}>Open by priority</h2>
          <div className="row">
            {['URGENT', 'HIGH', 'NORMAL', 'LOW'].map((p) => (
              <Link key={p} to={`/tickets?view=all&priority=${p}&status=NEW,OPEN,PENDING,ON_HOLD`} className="badge">
                {label(p)}: {s.byPriority[p] ?? 0}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
