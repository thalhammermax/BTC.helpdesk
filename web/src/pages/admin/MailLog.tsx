import { Link } from 'react-router-dom';
import { ago, api } from '../../api';
import { ErrorBox, useLoad } from '../../components/ui';

type Row = { id: string; from: string; subject: string; status: string; ticketId?: number; error?: string; createdAt: string };
export default function MailLog() {
  const { data, error, reload } = useLoad(() => api<Row[]>('/mail-log'));
  return (
    <>
      <div className="topline">
        <h1>Inbound mail log</h1>
        <button className="btn" onClick={async () => { await api('/mail/poll', { method: 'POST' }); reload(); }}>Check mailbox now</button>
      </div>
      <ErrorBox error={error} />
      <table className="list">
        <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Result</th><th>Ticket</th></tr></thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id}>
              <td className="muted">{ago(r.createdAt)}</td>
              <td>{r.from}</td>
              <td>{r.subject}</td>
              <td><span className="badge">{r.status}</span> {r.error && <span className="small muted">{r.error}</span>}</td>
              <td>{r.ticketId && <Link to={`/tickets/${r.ticketId}`}>#{r.ticketId}</Link>}</td>
            </tr>
          ))}
          {data?.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No email processed yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
