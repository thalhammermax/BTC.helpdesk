import { useState } from 'react';
import { api, type Category } from '../../api';
import { ErrorBox, useLoad } from '../../components/ui';

export default function Categories() {
  const { data, error, reload } = useLoad(() => api<Category[]>('/categories'));
  const [name, setName] = useState('');
  const [err, setErr] = useState<string>();
  const add = async () => { try { await api('/categories', { json: { name } }); setName(''); reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Categories</h1>
      <ErrorBox error={error ?? err} />
      <div className="row" style={{ flexWrap: 'nowrap', marginBottom: 12 }}>
        <input placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && add()} />
        <button className="btn primary" disabled={!name} onClick={add}>Add</button>
      </div>
      <table className="list">
        <tbody>
          {data?.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn sm" onClick={async () => { const n = prompt('Rename category', c.name); if (n) { await api(`/categories/${c.id}`, { method: 'PUT', json: { name: n } }); reload(); } }}>Rename</button>{' '}
                <button className="btn sm danger" onClick={async () => { if (confirm(`Delete ${c.name}?`)) { await api(`/categories/${c.id}`, { method: 'DELETE' }); reload(); } }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
