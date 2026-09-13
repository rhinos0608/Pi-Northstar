// Pi Web Access v0.29 additive-parity ingestion: bounded in-memory content store.
//
// Process memory only (no disk persistence — deliberate privacy divergence
// from upstream storage.ts). Bounds owned by src/web-access-contract.ts:
// 128 entries, 128 MiB, 1h TTL. LRU eviction; reject-never-truncate applies
// to the `all` provider set, while the store evicts oldest entries to stay
// bounded. No listing API (responseId lookup only).

import { randomUUID } from 'node:crypto';
import {
  WEB_ACCESS_STORE_MAX_BYTES,
  WEB_ACCESS_STORE_MAX_ENTRIES,
  WEB_ACCESS_STORE_TTL_MS,
  WebAccessContractError,
  type WebAccessClock,
  type WebAccessContentStore,
  type WebAccessIdGenerator,
  type WebAccessQueryResult,
  type WebAccessStoredEntry,
} from './web-access-contract.js';

export interface WebAccessStoreDeps {
  clock?: WebAccessClock | undefined;
  now?: (() => number) | undefined;
}

export interface WebAccessEntryDeps {
  clock?: WebAccessClock | undefined;
  idGenerator?: WebAccessIdGenerator | undefined;
  now?: (() => number) | undefined;
  randomId?: (() => string) | undefined;
}

function nowOf(deps: WebAccessEntryDeps | WebAccessStoreDeps): number {
  if ('clock' in deps && deps.clock) return deps.clock.now();
  if ('now' in deps && deps.now) return deps.now();
  return Date.now();
}

function idOf(deps: WebAccessEntryDeps): string {
  if (deps.idGenerator) return deps.idGenerator.randomId();
  if (deps.randomId) return deps.randomId();
  return randomUUID();
}

export function webAccessEntryBytes(queries: string[], results: WebAccessQueryResult[]): number {
  return Buffer.byteLength(JSON.stringify({ queries, results }), 'utf8');
}

export function buildWebAccessStoredEntry(
  input: { queries: string[]; results: WebAccessQueryResult[] },
  deps: WebAccessEntryDeps = {},
): WebAccessStoredEntry {
  const bytes = webAccessEntryBytes(input.queries, input.results);
  if (bytes > WEB_ACCESS_STORE_MAX_BYTES) {
    throw new WebAccessContractError(
      `stored entry exceeds maximum of ${WEB_ACCESS_STORE_MAX_BYTES} bytes`,
    );
  }
  return {
    responseId: idOf(deps),
    createdAt: nowOf(deps),
    bytes,
    queries: [...input.queries],
    results: input.results,
  };
}

export interface WebAccessMemoryStore extends WebAccessContentStore {
  prune(): number;
}

export function createWebAccessContentStore(deps: WebAccessStoreDeps = {}): WebAccessMemoryStore {
  const now = (): number => nowOf(deps);
  // Map preserves insertion order; get() refreshes recency for LRU.
  const entries = new Map<string, WebAccessStoredEntry>();
  let totalBytes = 0;

  function expired(entry: WebAccessStoredEntry, at: number): boolean {
    return at - entry.createdAt > WEB_ACCESS_STORE_TTL_MS;
  }

  function prune(at: number = now()): number {
    let removed = 0;
    for (const [key, entry] of entries) {
      if (expired(entry, at)) {
        entries.delete(key);
        totalBytes -= entry.bytes;
        removed++;
      }
    }
    return removed;
  }

  return {
    get(responseId: string): WebAccessStoredEntry | undefined {
      const entry = entries.get(responseId);
      if (!entry) return undefined;
      if (expired(entry, now())) {
        entries.delete(responseId);
        totalBytes -= entry.bytes;
        return undefined;
      }
      // Refresh LRU recency on access.
      entries.delete(responseId);
      entries.set(responseId, entry);
      return entry;
    },
    put(entry: WebAccessStoredEntry): void {
      if (entry.bytes > WEB_ACCESS_STORE_MAX_BYTES) {
        throw new WebAccessContractError(
          `stored entry exceeds maximum of ${WEB_ACCESS_STORE_MAX_BYTES} bytes`,
        );
      }
      prune();
      const existing = entries.get(entry.responseId);
      if (existing) {
        totalBytes -= existing.bytes;
        entries.delete(entry.responseId);
      }
      // Evict oldest until both caps hold.
      while (
        entries.size >= WEB_ACCESS_STORE_MAX_ENTRIES ||
        totalBytes + entry.bytes > WEB_ACCESS_STORE_MAX_BYTES
      ) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        const evicted = entries.get(oldest.value);
        entries.delete(oldest.value);
        if (evicted) totalBytes -= evicted.bytes;
      }
      entries.set(entry.responseId, entry);
      totalBytes += entry.bytes;
    },
    delete(responseId: string): void {
      const entry = entries.get(responseId);
      if (!entry) return;
      entries.delete(responseId);
      totalBytes -= entry.bytes;
    },
    size(): number {
      prune();
      return entries.size;
    },
    prune(): number {
      return prune();
    },
  };
}
