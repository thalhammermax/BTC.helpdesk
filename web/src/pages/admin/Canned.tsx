import { useState } from 'react';
import { api } from '../../api';
import { ErrorBox, Modal, useLoad } from '../../components/ui';

type C = { id?: string; title: string; body: string };
export default function Canned() {
  const { data, error, reload } = useLoad(() => api<Required<C>[]>('/canned'));
  const [edit, setEdit] = useState<C | null>(null);
  const save = async () => {
    const { id, ...body } = edit!;
    await api(id ? `/canned/${id}` : '/canned', { method: id ? 'PUT' : 'POST', json: body });
    setEdit(null);
    reload();
  };
  return (
    <>
      <div className="topline"><h1>Canned responses</h1><button className="btn primary" onClick={() => setEdit({ title: '', body: '' })}>+ New response</button></div>
      <ErrorBox error={error} />
      <div className="stack">
        {data?.map((c) => (
          <div key={c.id} className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{c.title}</h3>
              <span>
                <button className="btn sm" onClick={() => setEdit(c)}>Edit</button>{' '}
                <button className="btn sm danger" onClick={async () => { if (confirm('Delete?')) { await api(`/canned/${c.id}`, { method: 'DELETE' }); reload(); } }}>Delete</button>
              </span>
            </div>
            <div className="msg-body small muted" style={{ marginTop: 8 }}>{c.body}</div>
          </div>
        ))}
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit response' : 'New response'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={!edit.title || !edit.body} onClick={save}>Save</button></>}>
          <div className="stack">
            <label className="field">Title<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
            <label className="field">Text<textarea rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          </div>
        </Modal>
      )}
    </>
  );
}
