import { MailApiError } from '../mailbox/api';
import { editable, type Draft, type EditableDraft } from './api';
export type AutosaveGate = 'validation' | 'authorization' | 'conflict' | 'manual' | null;
export interface DraftSnapshot { draft: Draft; fields: EditableDraft; sequence: number; savedSequence: number; saving: boolean; conflict: boolean; error: string | null; retryAt: number | null; autosaveGate: AutosaveGate }
type Saver = (draft: Draft, fields: EditableDraft, mutationKey: string, signal: AbortSignal) => Promise<Draft>;
interface AutosaveOptions { enabled: boolean; accessActive: boolean; authContext: string; onSaved?: () => void }
/** One ordered save stream; acknowledgements never replace edits made after their snapshot. */
export class DraftSession {
  private value: DraftSnapshot;
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private saving: Promise<Draft> | null = null;
  private pending: { draft: Draft; fields: EditableDraft; sequence: number; key: string } | null = null;
  private autosave: AutosaveOptions = { enabled: false, accessActive: false, authContext: '' };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirtySince: number | null = null;
  private lastEditAt = 0;
  private retries = 0;
  private notBefore = 0;
  private flushAllRequested = false;
  constructor(draft: Draft, private readonly saver: Saver, private readonly key: () => string = () => crypto.randomUUID()) {
    this.value = { draft, fields: editable(draft), sequence: 0, savedSequence: 0, saving: false, conflict: false, error: null, retryAt: null, autosaveGate: null };
  }
  get signal() { return this.controller.signal; }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<DraftSnapshot>) { if (this.signal.aborted) return; this.value = { ...this.value, ...patch }; this.listeners.forEach(listener => listener()); }
  private cancelTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  configureAutosave(options: AutosaveOptions) {
    const renewed = options.accessActive && (!this.autosave.accessActive || options.authContext !== this.autosave.authContext);
    this.autosave = options;
    if (renewed && this.value.autosaveGate === 'authorization') this.update({ autosaveGate: null, error: null });
    this.schedule();
  }
  private edited(fields: EditableDraft) {
    this.lastEditAt = Date.now(); this.dirtySince ??= this.lastEditAt;
    const corrected = this.value.autosaveGate === 'validation';
    this.update({ fields, sequence: this.value.sequence + 1, ...(corrected ? { error: null, autosaveGate: null, retryAt: null } : {}) });
    this.schedule();
  }
  edit<K extends keyof EditableDraft>(field: K, value: EditableDraft[K]) { this.edited({ ...this.value.fields, [field]: value }); }
  replaceFields(fields: EditableDraft) { this.edited(fields); }
  acceptAction(draft: Draft) { this.update({ draft }); }
  replaceWithLatest(draft: Draft) {
    this.cancelTimer(); this.pending = null; this.retries = 0; this.notBefore = 0; this.dirtySince = null;
    this.update({ draft, fields: editable(draft), sequence: 0, savedSequence: 0, conflict: false, error: null, retryAt: null, autosaveGate: null });
  }
  dispose() { this.cancelTimer(); this.controller.abort(); this.listeners.clear(); }
  async settle(): Promise<Draft> { if (this.saving) await this.saving.catch(() => {}); return this.value.draft; }
  save(): Promise<Draft> { return this.startSave(true); }
  private schedule() {
    this.cancelTimer();
    if (this.signal.aborted || !this.autosave.enabled || !this.autosave.accessActive || this.saving || this.value.conflict || this.value.autosaveGate
      || (!this.pending && this.value.sequence === this.value.savedSequence)) return;
    const now = Date.now();
    const ordinaryDeadline = Math.min(this.lastEditAt + 1000, (this.dirtySince ?? now) + 10000);
    const deadline = Math.max(this.notBefore, this.value.retryAt ?? ordinaryDeadline);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (Date.now() < deadline) { this.schedule(); return; }
      void this.startSave(false).then(() => this.autosave.onSaved?.()).catch(() => {});
    }, Math.min(2_147_483_647, Math.max(0, deadline - now)));
  }
  private startSave(flushAll: boolean): Promise<Draft> {
    if (flushAll) this.flushAllRequested = true;
    if (this.saving) return this.saving;
    if (this.value.conflict) return Promise.reject(new MailApiError('Resolve this draft conflict before saving.', 409));
    if (Date.now() < this.notBefore) return Promise.reject(new MailApiError('The service asked us to wait before retrying. Your edits are still here.', 429, 'retry_later', this.notBefore - Date.now()));
    this.cancelTimer(); this.flushAllRequested = flushAll;
    this.saving = this.flush().finally(() => { this.saving = null; this.schedule(); }); return this.saving;
  }
  private async flush(): Promise<Draft> {
    this.update({ saving: true, error: null, retryAt: null });
    try {
      while (this.pending || this.value.savedSequence !== this.value.sequence) {
        if (!this.pending) this.pending = { draft: this.value.draft, fields: structuredClone(this.value.fields), sequence: this.value.sequence, key: this.key() };
        const request = this.pending;
        const saved = await this.saver(request.draft, request.fields, request.key, this.signal);
        if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (saved.id !== request.draft.id || saved.mailboxId !== request.draft.mailboxId || saved.version < request.draft.version) throw new MailApiError('Invalid draft save acknowledgement.');
        this.pending = null; this.retries = 0; this.notBefore = 0;
        this.dirtySince = this.value.sequence === request.sequence ? null : this.lastEditAt;
        this.update({ draft: saved, savedSequence: request.sequence, autosaveGate: null, ...(this.value.sequence === request.sequence ? { fields: editable(saved) } : {}) });
        if (!this.flushAllRequested) break;
      }
      return this.value.draft;
    } catch (failure) {
      if (!this.signal.aborted) {
        const status = failure instanceof MailApiError ? failure.status : undefined;
        const gate: AutosaveGate = [400, 413, 422].includes(status ?? 0) ? 'validation'
          : status === 401 || status === 403 ? 'authorization' : status === 409 ? 'conflict'
          : status === undefined || status === 408 || status === 429 || status >= 500 ? null : 'manual';
        // Definitive validation rejection committed nothing. Ambiguous outcomes retain the exact request/key.
        if (gate === 'validation') { this.pending = null; this.retries = 0; this.notBefore = 0; }
        let retryAt: number | null = null;
        if (gate === null) {
          this.retries = Math.min(30, this.retries + 1);
          const backoff = Math.min(60_000, 2000 * 2 ** (this.retries - 1));
          this.notBefore = Date.now() + (failure instanceof MailApiError ? failure.retryAfterMs ?? 0 : 0);
          retryAt = Math.max(Date.now() + backoff, this.notBefore);
        }
        this.update({ error: failure instanceof Error ? failure.message : 'Draft could not be saved.', conflict: gate === 'conflict', autosaveGate: gate, retryAt });
      }
      throw failure;
    } finally { this.update({ saving: false }); }
  }
}
