// Search-attempt ledger core (Task 4): pure bounded in-memory state machine.
//
// Coalesces in-flight duplicate searches, suppresses completed near-duplicates,
// and blocks repeated failures with bounded retries. Stores only SHA-256
// hashes, outcome state, counters, and safe failure codes — never result
// bodies, raw upstream errors, query text, or secrets.
//
// No I/O, no fetch, no timers. Time comes from an injectable clock so TTL
// behavior is deterministic under test. Not wired into execution here.

import { createHash } from 'node:crypto';

export const SUCCESS_SUPPRESS_MS = 30 * 60_000;
export const FAILURE_BLOCK_MS = 10 * 60_000;
export const MAX_LEDGER_ENTRIES = 128;
export const MAX_LEDGER_ACTIVE_SEARCHES = 32;
export const NEAR_DUPLICATE_JACCARD = 0.85;

export type LedgerFailureCode =
  | 'timeout'
  | 'upstream_error'
  | 'invalid_response'
  | 'response_too_large';

export interface WebSearchLedgerOptions {
  limit?: number;
  includeContent?: boolean;
  recency?: string;
  domains?: readonly string[];
  yearFrom?: number;
  knowledge?: Record<string, boolean>;
  mode?: string;
  category?: string;
  source?: string;
}

export interface WebSearchLedgerConfig {
  now?: () => number;
  maxEntries?: number;
}

export type LedgerBeginResult =
  | { status: 'run'; key: string }
  | { status: 'coalesced'; key: string; promise: Promise<unknown> }
  | { status: 'suppressed' }
  | { status: 'blocked' };

export interface LedgerDebugEntry {
  hash: string;
  state: 'success' | 'failed' | 'blocked';
  failures: number;
  code?: LedgerFailureCode;
}

interface CompletedEntry {
  hash: string;
  single: boolean;
  /** SHA-256 of each normalized token; empty for batch entries. */
  tokens: Set<string>;
  optionsKey: string;
  successAt: number | undefined;
  failureCount: number;
  lastFailureAt: number | undefined;
  lastCode: LedgerFailureCode | undefined;
  lastRetryable: boolean | undefined;
}

interface PendingContext {
  tokens: Set<string>;
  single: boolean;
  optionsKey: string;
}

interface InFlightEntry {
  key: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  promise: Promise<unknown>;
  waiters: number;
}

function normalizeQuery(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

function tokenize(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function canonicalOptions(options: WebSearchLedgerOptions | undefined): string {
  const source = options ?? {};
  const domains =
    source.domains === undefined ? undefined : [...source.domains].map((d) => d.toLowerCase()).sort();
  const knowledge =
    source.knowledge === undefined
      ? undefined
      : Object.fromEntries(Object.entries(source.knowledge).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({
    limit: source.limit ?? null,
    includeContent: source.includeContent ?? null,
    recency: source.recency ?? null,
    domains: domains ?? null,
    yearFrom: source.yearFrom ?? null,
    knowledge: knowledge ?? null,
    mode: source.mode ?? null,
    category: source.category ?? null,
    source: source.source ?? null,
  });
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export class WebSearchLedger {
  private readonly clock: () => number;
  private readonly maxEntries: number;
  private readonly completed = new Map<string, CompletedEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly pending = new Map<string, PendingContext>();

  constructor(config?: WebSearchLedgerConfig) {
    this.clock = config?.now ?? Date.now;
    this.maxEntries = config?.maxEntries ?? MAX_LEDGER_ENTRIES;
  }

  get size(): number {
    return this.completed.size;
  }

  begin(queries: string[], options?: WebSearchLedgerOptions, signal?: AbortSignal): LedgerBeginResult {
    const now = this.clock();
    const normalized = queries.map(normalizeQuery);
    const optionsKey = canonicalOptions(options);
    const key = createHash('sha256').update(`${normalized.join('\n')}|${optionsKey}`, 'utf8').digest('hex');
    const single = normalized.length === 1;

    this.expireLocked(now);

    const existing = this.completed.get(key);
    if (existing !== undefined && this.isBlocked(existing, now)) {
      this.touch(key, existing);
      return { status: 'blocked' };
    }

    const flying = this.inFlight.get(key);
    if (flying !== undefined) {
      flying.waiters += 1;
      return { status: 'coalesced', key, promise: this.follow(flying, signal) };
    }

    if (existing !== undefined) this.touch(key, existing);
    if (single && this.findFuzzySuccess(normalized[0]!, optionsKey, now) !== undefined) {
      return { status: 'suppressed' };
    }
    // Batch entries suppress only on exact canonical match (checked above via
    // `existing`); near-duplicate batches intentionally fall through to run.
    if (!single && existing?.successAt !== undefined && now - existing.successAt < SUCCESS_SUPPRESS_MS) {
      return { status: 'suppressed' };
    }

    if (this.activeLocked() >= MAX_LEDGER_ACTIVE_SEARCHES) {
      // Active cap reached: bypass tracking for this new search instead of
      // evicting a live entry. Completion still records a bounded outcome.
      return { status: 'run', key };
    }
    let resolve!: (result: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    // The executor settles before followers attach handlers; never emit an
    // unhandled rejection from the shared promise.
    promise.catch(() => {});
    this.inFlight.set(key, { key, resolve, reject, promise, waiters: 1 });
    this.pending.set(key, {
      tokens: single ? new Set(tokenize(normalized[0]!).map(hashToken)) : new Set<string>(),
      single,
      optionsKey,
    });
    return { status: 'run', key };
  }

  completeSuccess(key: string, result?: unknown): void {
    const flying = this.inFlight.get(key);
    const now = this.clock();
    const context = this.pending.get(key);
    this.pending.delete(key);
    if (flying !== undefined) {
      this.inFlight.delete(key);
      // Transient leader result travels on the shared promise only; the
      // stored completion keeps hashes/counters, never bodies.
      flying.resolve(result);
    }
    // Untracked bypass (active cap reached in begin()): no pending context
    // and no shared promise, so tokens/options are unknown. Skip recording
    // rather than storing a single:true entry with empty tokens/options
    // that would pollute fuzzy suppression and LRU accounting.
    if (flying === undefined && context === undefined) return;
    const prior = this.completed.get(key);
    this.storeLocked({
      hash: key,
      single: prior?.single ?? context?.single ?? true,
      tokens: context?.tokens ?? prior?.tokens ?? new Set<string>(),
      optionsKey: context?.optionsKey ?? prior?.optionsKey ?? '',
      successAt: now,
      failureCount: 0,
      // Success clears failure metadata: a retained lastFailureAt /
      // lastRetryable would keep isBlocked() true and forbid the retry
      // the reset failureCount just allowed.
      lastFailureAt: undefined,
      lastCode: undefined,
      lastRetryable: undefined,
    });
  }

  completeFailure(key: string, info: { retryable: boolean; code: LedgerFailureCode }): void {
    const flying = this.inFlight.get(key);
    const now = this.clock();
    const context = this.pending.get(key);
    this.pending.delete(key);
    if (flying !== undefined) {
      this.inFlight.delete(key);
      flying.reject(Object.assign(new Error(info.code), { name: 'LedgerSearchError' }));
    }
    // Same untracked-bypass rule as completeSuccess: without a pending
    // context or shared promise there is nothing safe to record.
    if (flying === undefined && context === undefined) return;
    const prior = this.completed.get(key);
    // Consecutive failures: retryable allows one retry (second run), then the
    // third attempt blocks. Non-retryable blocks immediately.
    const failureCount = (prior?.successAt !== undefined ? 0 : (prior?.failureCount ?? 0)) + 1;
    this.storeLocked({
      hash: key,
      single: prior?.single ?? context?.single ?? true,
      tokens: prior?.tokens ?? context?.tokens ?? new Set<string>(),
      optionsKey: prior?.optionsKey ?? context?.optionsKey ?? '',
      successAt: undefined,
      failureCount,
      lastFailureAt: now,
      lastCode: info.code,
      lastRetryable: info.retryable,
    });
  }

  /** Caller abort: drop in-flight tracking without recording a failure. */
  cancel(key: string): void {
    const flying = this.inFlight.get(key);
    this.pending.delete(key);
    if (flying === undefined) return;
    this.inFlight.delete(key);
    flying.reject(abortError());
  }

  debugEntries(): LedgerDebugEntry[] {
    const now = this.clock();
    const out: LedgerDebugEntry[] = [];
    for (const entry of this.completed.values()) {
      const state =
        this.isBlocked(entry, now) ? 'blocked' : entry.successAt !== undefined ? 'success' : 'failed';
      out.push({
        hash: entry.hash,
        state,
        failures: entry.failureCount,
        ...(entry.lastCode !== undefined ? { code: entry.lastCode } : {}),
      });
    }
    return out;
  }

  private activeLocked(): number {
    return new Set([...this.inFlight.keys(), ...this.pending.keys()]).size;
  }

  private follow(flying: InFlightEntry, signal?: AbortSignal): Promise<unknown> {
    if (signal === undefined) return flying.promise;
    if (signal.aborted) {
      flying.waiters -= 1;
      return Promise.reject(abortError());
    }
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        flying.waiters -= 1;
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      flying.promise.then(
        (result: unknown) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error as Error);
        },
      );
    });
  }

  private isBlocked(entry: CompletedEntry, now: number): boolean {
    if (entry.lastFailureAt === undefined) return false;
    if (now - entry.lastFailureAt >= FAILURE_BLOCK_MS) return false;
    if (entry.lastRetryable === false) return true;
    // Retryable: first failure still permits one retry; second blocks.
    return entry.failureCount >= 2;
  }

  private findFuzzySuccess(
    normalizedQuery: string,
    optionsKey: string,
    now: number,
  ): CompletedEntry | undefined {
    const tokens = new Set(tokenize(normalizedQuery).map(hashToken));
    for (const entry of this.completed.values()) {
      if (!entry.single || entry.successAt === undefined) continue;
      if (now - entry.successAt >= SUCCESS_SUPPRESS_MS) continue;
      if (entry.optionsKey !== optionsKey) continue;
      if (jaccard(tokens, entry.tokens) >= NEAR_DUPLICATE_JACCARD) {
        this.touch(entry.hash, entry);
        return entry;
      }
    }
    return undefined;
  }

  private touch(key: string, entry: CompletedEntry): void {
    this.completed.delete(key);
    this.completed.set(key, entry);
  }

  private storeLocked(entry: CompletedEntry): void {
    this.completed.delete(entry.hash);
    this.completed.set(entry.hash, entry);
    while (this.completed.size > this.maxEntries) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private expireLocked(now: number): void {
    for (const [key, entry] of [...this.completed]) {
      const successLive = entry.successAt !== undefined && now - entry.successAt < SUCCESS_SUPPRESS_MS;
      if (successLive) continue;
      if (this.isBlocked(entry, now)) continue;
      // A recent first retryable failure is kept for retry counting.
      if (entry.lastFailureAt !== undefined && now - entry.lastFailureAt < FAILURE_BLOCK_MS) continue;
      this.completed.delete(key);
    }
  }
}
