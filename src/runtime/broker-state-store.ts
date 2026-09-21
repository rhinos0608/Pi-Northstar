import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

export const BROKER_STATE_VERSION = 1 as const;
export interface JobSubmissionReceipt { jobId: string; clientId: string; requestId: string; submittedAt: number; }
interface StateDocument { version: 1; epoch: string; receipts: JobSubmissionReceipt[]; mutationIds: string[]; }
export type BrokerStateErrorCode = 'state_corrupt' | 'state_incompatible' | 'state_io' | 'duplicate_mutation';
export class BrokerStateError extends Error { readonly code: BrokerStateErrorCode; constructor(code: BrokerStateErrorCode, message: string = code) { super(message); this.name = 'BrokerStateError'; this.code = code; } }
export class BrokerDuplicateMutationError extends BrokerStateError { constructor(message: string = 'Duplicate mutation.') { super('duplicate_mutation', message); this.name = 'BrokerDuplicateMutationError'; } }
function validReceipt(value: unknown): value is JobSubmissionReceipt { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const r = value as Record<string, unknown>; return typeof r.jobId === 'string' && typeof r.clientId === 'string' && typeof r.requestId === 'string' && typeof r.submittedAt === 'number' && Number.isSafeInteger(r.submittedAt); }
function validDocument(value: unknown, maxEntries: number): value is StateDocument { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const d = value as Record<string, unknown>; return d.version === BROKER_STATE_VERSION && typeof d.epoch === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(d.epoch) && Array.isArray(d.receipts) && d.receipts.length <= maxEntries && d.receipts.every(validReceipt) && Array.isArray(d.mutationIds) && d.mutationIds.length <= maxEntries && d.mutationIds.every(id => typeof id === 'string'); }
/** Atomic owner-local state. Corruption and unknown versions fail closed. */
export class BrokerStateStore {
  private state: StateDocument | undefined;
  constructor(readonly path: string, private readonly maxReceipts = 512) { if (!Number.isInteger(maxReceipts) || maxReceipts < 1) throw new RangeError('Invalid receipt bound.'); }
  async open(): Promise<{ epoch: string; restarted: boolean }> { const document = await this.load(); const restarted = document !== undefined; this.state = document ?? { version: BROKER_STATE_VERSION, epoch: this.newEpoch(), receipts: [], mutationIds: [] }; this.state = { ...this.state, epoch: this.newEpoch() }; await this.persist(); return { epoch: this.state.epoch, restarted }; }
  /** Load persisted state for queries without rotating epoch or writing. */
  async openReadOnly(): Promise<void> { this.state = await this.load() ?? { version: BROKER_STATE_VERSION, epoch: this.newEpoch(), receipts: [], mutationIds: [] }; }
  private async load(): Promise<StateDocument | undefined> { try { const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown; if (!raw || typeof raw === 'object' && (raw as Record<string, unknown>).version !== BROKER_STATE_VERSION) throw new BrokerStateError('state_incompatible'); if (!validDocument(raw, this.maxReceipts)) throw new BrokerStateError('state_corrupt'); return raw; } catch (error) { if (error instanceof BrokerStateError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BrokerStateError('state_corrupt'); return undefined; } }
  get epoch(): string { if (!this.state) throw new BrokerStateError('state_io', 'State store is not open.'); return this.state.epoch; }
  getReceipt(clientId: string, requestId: string): JobSubmissionReceipt | undefined { return this.requireState().receipts.find(r => r.clientId === clientId && r.requestId === requestId); }
  async getReceiptReadOnly(clientId: string, requestId: string): Promise<JobSubmissionReceipt | undefined> { return this.getReceipt(clientId, requestId); }
  async claimMutation(mutationId: string): Promise<void> { const state = this.requireState(); if (state.mutationIds.includes(mutationId)) throw new BrokerDuplicateMutationError('Duplicate mutation.'); state.mutationIds.push(mutationId); if (state.mutationIds.length > this.maxReceipts) state.mutationIds.splice(0, state.mutationIds.length - this.maxReceipts); await this.persist(); }
  async recordJobSubmission(receipt: JobSubmissionReceipt): Promise<void> { if (!validReceipt(receipt)) throw new BrokerStateError('state_corrupt', 'Invalid job receipt.'); const state = this.requireState(); if (!this.getReceipt(receipt.clientId, receipt.requestId)) { state.receipts.push({ ...receipt }); if (state.receipts.length > this.maxReceipts) state.receipts.splice(0, state.receipts.length - this.maxReceipts); await this.persist(); } }
  snapshot(): { version: 1; epoch: string; receipts: JobSubmissionReceipt[] } { const state = this.requireState(); return { version: 1, epoch: state.epoch, receipts: state.receipts.map(r => ({ ...r })) }; }
  private requireState(): StateDocument { if (!this.state) throw new BrokerStateError('state_io', 'State store is not open.'); return this.state; }
  private newEpoch(): string { return randomBytes(16).toString('base64url'); }
  private async persist(): Promise<void> { const state = this.requireState(); const temporary = `${this.path}.tmp-${process.pid}`; try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, this.path); } catch (error) { throw new BrokerStateError('state_io', error instanceof Error ? error.message : 'State write failed.'); } }
}
export async function queryJobSubmission(path: string, clientId: string, requestId: string): Promise<JobSubmissionReceipt | undefined> { const store = new BrokerStateStore(path); await store.openReadOnly(); return store.getReceipt(clientId, requestId); }
