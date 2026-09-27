import { useRef, useState } from 'react';
import type { MailAddress } from './api';

/** Only parses explicit user input; original MIME recipients always come from the backend. */
export function parseTypedRecipients(input: string): MailAddress[] {
  const chunks: string[] = []; let start = 0, quoted = false, angle = 0, escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]; if (escaped) { escaped = false; continue; } if (c === '\\' && quoted) { escaped = true; continue; }
    if (c === '"') quoted = !quoted; if (!quoted && c === '<') angle++; if (!quoted && c === '>') angle = Math.max(0, angle - 1);
    if (!quoted && !angle && (c === ',' || c === ';' || c === '\n')) { chunks.push(input.slice(start, i)); start = i + 1; }
  }
  chunks.push(input.slice(start));
  return chunks.map(part => part.trim()).filter(Boolean).map(raw => {
    const match = raw.match(/^(.*?)\s*<([^<>]+)>$/); return match ? { name: match[1]!.trim().replace(/^"(.*)"$/, '$1'), address: match[2]!.trim() } : { name: '', address: raw };
  });
}
export function RecipientField({ label, values, onChange, disabled }: { label: string; values: MailAddress[]; onChange: (values: MailAddress[]) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState<number | null>(null); const input = useRef<HTMLInputElement>(null);
  const current = editing === null ? '' : values[editing]?.address ?? '';
  function change(raw: string) { if (editing === null) { const index = values.length; setEditing(index); onChange([...values, { name: '', address: raw }]); } else onChange(values.map((v, i) => i === editing ? { name: '', address: raw } : v)); }
  function commit() { if (editing === null) return; const parsed = parseTypedRecipients(current); onChange([...values.slice(0, editing), ...parsed, ...values.slice(editing + 1)]); setEditing(null); }
  return <div className="recipient-field"><label htmlFor={`compose-${label.toLowerCase()}`}>{label}</label><div className="recipient-chips" onClick={() => input.current?.focus()}>
    {values.map((value, index) => index === editing ? null : <span className="recipient-chip" key={index} title={value.address}><button type="button" disabled={disabled} onClick={() => { setEditing(index); input.current?.focus(); }}>{value.name ? `${value.name} <${value.address}>` : value.address || '(Empty address)'}</button><button type="button" disabled={disabled} aria-label={`Remove ${value.address} from ${label}`} onClick={event => { event.stopPropagation(); onChange(values.filter((_, i) => i !== index)); if (editing !== null && editing > index) setEditing(editing - 1); }}>×</button></span>)}
    <input ref={input} id={`compose-${label.toLowerCase()}`} aria-label={label} type="text" value={current} disabled={disabled} placeholder={values.length ? '' : 'Add recipient'} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => change(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Tab' && current) { if (event.key === 'Enter') event.preventDefault(); commit(); } if (event.key === 'Backspace' && !current && editing === null && values.length) setEditing(values.length - 1); }} />
  </div></div>;
}
