import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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

/** A comma inside a display name or angle address belongs to the unfinished input. */
export function recipientDelimiterIsOutside(input: string): boolean {
  let quoted = false, angle = 0, escaped = false;
  for (const character of input) {
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quoted) { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === '<') angle++;
    else if (!quoted && character === '>') angle = Math.max(0, angle - 1);
  }
  return !quoted && angle === 0;
}

type PendingRecipient = { index: number; value: string };
type SelectedRecipient = { index: number; address: string; name: string };
const matches = (value: MailAddress | undefined, selected: SelectedRecipient | null) =>
  !!value && !!selected && value.address === selected.address && value.name === selected.name;

export function RecipientField({ label, values, onChange, disabled, actions, autoFocus = false, onInputFocus }: {
  label: string;
  values: MailAddress[];
  onChange: (values: MailAddress[]) => void;
  disabled?: boolean;
  actions?: ReactNode;
  autoFocus?: boolean;
  onInputFocus?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const keyboardHintId = useId();
  const [announcement, setAnnouncement] = useState({ revision: 0, text: '' });
  const chipButtons = useRef(new Map<number, HTMLButtonElement>());
  const composing = useRef(false);
  const valuesRef = useRef(values); valuesRef.current = values;
  const [pending, setPending] = useState<PendingRecipient | null>(null);
  const pendingRef = useRef(pending);
  const [selected, setSelected] = useState<SelectedRecipient | null>(null);
  const selectedRef = useRef(selected);
  const activePending = pending && values[pending.index]?.name === '' && values[pending.index]?.address === pending.value ? pending : null;
  const activeSelected = selected && matches(values[selected.index], selected) ? selected : null;
  const inputValue = activePending?.value ?? '';

  function select(value: SelectedRecipient | null) { selectedRef.current = value; setSelected(value); }
  function setInput(value: PendingRecipient | null) { pendingRef.current = value; setPending(value); }
  function publish(next: MailAddress[]) { valuesRef.current = next; onChange(next); }
  function pendingEntry(): PendingRecipient | null {
    const current = pendingRef.current;
    return current && valuesRef.current[current.index]?.name === '' && valuesRef.current[current.index]?.address === current.value ? current : null;
  }
  useEffect(() => {
    // A server-version replacement is not permission to edit a pre-existing chip.
    if (pending && !activePending) { pendingRef.current = null; setPending(null); }
    if (selected && !activeSelected) { selectedRef.current = null; setSelected(null); }
  }, [values, pending, selected, activePending, activeSelected]);

  function focusInput() { select(null); input.current?.focus(); }
  function focusChip(index: number) {
    const value = valuesRef.current[index];
    if (!value || pendingEntry()?.index === index) { focusInput(); return; }
    select({ index, ...value }); chipButtons.current.get(index)?.focus();
  }
  function change(raw: string) {
    select(null);
    const current = pendingEntry(), list = valuesRef.current;
    if (!current && !raw) return;
    const index = current?.index ?? list.length;
    if (current?.value === raw) return;
    setInput({ index, value: raw });
    // The unfinished entry remains in the authoritative draft fields for autosave.
    publish(current ? list.map((value, i) => i === index ? { name: '', address: raw } : value) : [...list, { name: '', address: raw }]);
  }
  function commit(raw = pendingEntry()?.value ?? '') {
    if (composing.current) return;
    const current = pendingEntry(); if (!current) return;
    const list = valuesRef.current, parsed = parseTypedRecipients(raw);
    setInput(null); select(null);
    publish([...list.slice(0, current.index), ...parsed, ...list.slice(current.index + 1)]);
  }
  function remove(index: number) {
    if (disabled) return;
    const current = pendingEntry(), list = valuesRef.current;
    if (!list[index] || current?.index === index) return;
    if (current && current.index > index) setInput({ ...current, index: current.index - 1 });
    const removed = list[index]!;
    setAnnouncement(previous => ({ revision: previous.revision + 1, text: `${removed.name ? `${removed.name} <${removed.address}>` : removed.address || 'Empty recipient'} removed from ${label}.` }));
    select(null); publish(list.filter((_, i) => i !== index)); input.current?.focus();
  }
  function isComposing(event: KeyboardEvent) { return composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229; }
  function inputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled || isComposing(event)) return;
    const raw = event.currentTarget.value;
    if (event.key === 'Enter' || event.key === 'Tab' && raw || (event.key === ',' || event.key === ';') && recipientDelimiterIsOutside(raw)) {
      if (event.key !== 'Tab') event.preventDefault(); commit(raw); return;
    }
    if (!raw && (event.key === 'Backspace' || event.key === 'ArrowLeft')) {
      event.preventDefault(); if (event.repeat) return;
      // An empty unfinished entry is not a committed chip and must not consume the selection step.
      const current = pendingEntry(); if (current) { setInput(null); publish(valuesRef.current.filter((_, i) => i !== current.index)); }
      focusChip(valuesRef.current.length - 1);
    } else if (event.key === 'Escape') { select(null); }
  }
  function chipKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled || isComposing(event)) return;
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault(); if (event.repeat) return;
      if (selectedRef.current?.index !== index || !matches(valuesRef.current[index], selectedRef.current)) focusChip(index);
      else remove(index);
    } else if (event.key === 'ArrowLeft') { event.preventDefault(); if (index > 0) focusChip(index - 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); focusChip(index + 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusChip(0); }
    else if (event.key === 'End' || event.key === 'Escape') { event.preventDefault(); focusInput(); }
  }

  return <div className="recipient-field" id={`compose-${label.toLowerCase()}-row`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) select(null); }}>
    <label htmlFor={`compose-${label.toLowerCase()}`}>{label}</label>
    <div className="recipient-chips" onClick={focusInput}>
      {values.map((value, index) => activePending?.index === index ? null : <span className={`recipient-chip${activeSelected?.index === index ? ' is-selected' : ''}`} key={index} title={value.address}>
        <button ref={node => { if (node) chipButtons.current.set(index, node); else chipButtons.current.delete(index); }} className="recipient-chip-select" type="button" disabled={disabled} tabIndex={activeSelected?.index === index ? 0 : -1} aria-label={activeSelected?.index === index ? `${value.name ? `${value.name} <${value.address}>` : value.address || '(Empty address)'}, selected` : undefined} aria-describedby={keyboardHintId} onFocus={() => select({ index, ...value })} onClick={event => { event.stopPropagation(); focusChip(index); }} onKeyDown={event => chipKeyDown(event, index)}>{value.name ? `${value.name} <${value.address}>` : value.address || '(Empty address)'}</button>
        <button className="recipient-chip-remove" type="button" tabIndex={-1} disabled={disabled} aria-label={`Remove ${value.address} from ${label}`} onClick={event => { event.stopPropagation(); remove(index); }}>×</button>
      </span>)}
      <input ref={input} className="recipient-input" id={`compose-${label.toLowerCase()}`} aria-label={label} aria-describedby={keyboardHintId} type="text" value={inputValue} disabled={disabled} placeholder={values.length ? '' : 'Add recipient'} autoFocus={autoFocus} autoComplete="off" autoCapitalize="none" spellCheck={false}
        onFocus={() => { select(null); onInputFocus?.(); }} onChange={event => change(event.target.value)} onBlur={event => { if (composing.current) { composing.current = false; return; } commit(event.currentTarget.value); }} onKeyDown={inputKeyDown}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; change(event.currentTarget.value); }} />
    </div>
    {actions && <div className="recipient-field-actions">{actions}</div>}
    <span className="sr-only" id={keyboardHintId}>When the input is empty, Backspace or Left Arrow selects the previous recipient. With a recipient selected, Backspace or Delete removes it. Left and Right Arrow move between recipients; Escape returns to the input.</span>
    <span className="sr-only recipient-removal-status" role="status" aria-live="polite" aria-atomic="true"><span key={announcement.revision}>{announcement.text}</span></span>
  </div>;
}
