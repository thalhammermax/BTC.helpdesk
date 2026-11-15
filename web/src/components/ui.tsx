import { useEffect, useState, type ReactNode } from 'react';
import { label, type Priority, type Status } from '../api';

export const StatusBadge = ({ s }: { s: Status }) => <span className={`badge s-${s}`}>{label(s)}</span>;
export const Prio = ({ p }: { p: Priority }) => <span className={`prio p-${p}`}>{label(p)}</span>;

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Tag-style list input: Enter or comma adds an item. */
export function Chips({ value, onChange, placeholder, variant }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; variant?: 'ex' }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft('');
  };
  return (
    <div className="chips">
      {value.map((v) => (
        <span key={v} className={`chip ${variant ?? ''}`}>
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft); }
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft && add(draft)}
      />
    </div>
  );
}

export function ErrorBox({ error }: { error?: string | null }) {
  return error ? <div className="error">{error}</div> : null;
}

/** Load data with a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && (setData(d), setError(undefined))).catch((e) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}
