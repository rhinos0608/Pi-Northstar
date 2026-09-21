import { randomUUID } from 'node:crypto';

export const DEFAULT_REPLAY_LIMITS = {
  maxEntries: 512,
  maxBytes: 4 * 1024 * 1024,
  ttlMs: 10 * 60 * 1000,
} as const;

export type BrokerReplayErrorCode = 'sequence_replay' | 'duplicate_mutation';
export class BrokerReplayError extends Error {
  readonly code: BrokerReplayErrorCode;
  constructor(code: BrokerReplayErrorCode, message: string = code) { super(message); this.name = 'BrokerReplayError'; this.code = code; }
}

/** Enforces request sequence 1,2,3... for one authenticated connection. */
export class BrokerSequenceGuard {
  private last = 0;
  get lastSequence(): number { return this.last; }
  accept(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence !== this.last + 1) throw new BrokerReplayError('sequence_replay');
    this.last = sequence;
  }
  reset(): void { this.last = 0; }
}

type CacheEntry<T> = { value: T; expiresAt: number; bytes: number };
export interface ReplayCacheOptions { maxEntries?: number; maxBytes?: number; ttlMs?: number; now?: () => number; }

/** Bounded cache for reads only. Eviction never changes mutation semantics. */
export class BrokerReadIdempotencyCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(options: ReplayCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_REPLAY_LIMITS.maxEntries;
    this.maxBytes = options.maxBytes ?? DEFAULT_REPLAY_LIMITS.maxBytes;
    this.ttlMs = options.ttlMs ?? DEFAULT_REPLAY_LIMITS.ttlMs;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || !Number.isInteger(this.maxBytes) || this.maxBytes < 1 || !Number.isInteger(this.ttlMs) || this.ttlMs < 1) throw new RangeError('Invalid replay cache bounds.');
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry); return entry.value;
  }
  set(key: string, value: T): boolean {
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'); } catch { return false; }
    if (bytes > this.maxBytes) return false;
    this.delete(key); this.prune();
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return false;
      this.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs, bytes }); this.bytes += bytes; return true;
  }
  delete(key: string): void { const entry = this.entries.get(key); if (entry) this.bytes -= entry.bytes; this.entries.delete(key); }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  get size(): number { return this.entries.size; }
  private prune(): void { for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.delete(key); }
}

/** Mutation IDs are one-shot. A duplicate is always rejected, never replayed. */
export class BrokerMutationLedger {
  private readonly ids = new Set<string>();
  claim(mutationId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(mutationId)) throw new BrokerReplayError('duplicate_mutation', 'Invalid mutation ID.');
    if (this.ids.has(mutationId)) throw new BrokerReplayError('duplicate_mutation');
    this.ids.add(mutationId);
  }
  has(mutationId: string): boolean { return this.ids.has(mutationId); }
  clear(): void { this.ids.clear(); }
}

export function newMutationId(): string { return randomUUID().replaceAll('-', '_'); }
export function mutationTransportLoss(): { outcome: 'outcome_unknown'; retry: false } { return { outcome: 'outcome_unknown', retry: false }; }
export function isMutationMethod(method: string): boolean { return method === 'start' || method === 'cancelAndSettle'; }
