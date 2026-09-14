// Plan B4 retention: delete-in-finally for raw assets/renders/keyframes/
// temp credentials, bounded orphan telemetry for failed cloud-upload
// deletion, 1h TTL checks for derived/response entries, and optional
// derived-only persistence (env-gated, default-off).
//
// Telemetry records carry kind + reason + timestamp only — never provider,
// model, URLs, or secrets.

import { WEB_ACCESS_STORE_TTL_MS } from '../web/access/web-access-contract.js';

/** Default orphan-telemetry bound (LRU, operator-lowerable via env). */
export const ORPHAN_TELEMETRY_DEFAULT_MAX = 64;

/** Max age for optional derived-only persistence (≤24h). */
export const DERIVED_PERSISTENCE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Warning surfaced whenever derived-only persistence is enabled. */
export const DERIVED_PERSISTENCE_WARNING =
  'derived-only persistence is enabled: derived evidence may rest on disk up to 24h; ' +
  'raw assets, renders, keyframes, and temp credentials are still deleted in finally';

/** Raw asset classes that MUST be deleted in finally. */
export type RawAssetKind = 'raw-asset' | 'render' | 'keyframe' | 'temp-credential' | 'cloud-upload';

export interface OrphanRecord {
  kind: RawAssetKind;
  /** Opaque local id (temp path hash or upload id) — never a URL or secret. */
  ref: string;
  reason: string;
  at: number;
}

export type UnlinkFn = (path: string) => Promise<void> | void;
export type DeleteRemoteFn = (ref: string) => Promise<void> | void;

/**
 * LRU-bounded orphan telemetry. Oldest records evict first; bound
 * operator-lowerable via constructor (env wiring lives with the caller).
 */
export class OrphanTelemetry {
  private readonly records: OrphanRecord[] = [];
  constructor(private readonly maxEntries: number = ORPHAN_TELEMETRY_DEFAULT_MAX) {}

  record(entry: Omit<OrphanRecord, 'at'>, now: number = Date.now()): void {
    this.records.push({ ...entry, at: now });
    while (this.records.length > Math.max(1, this.maxEntries)) this.records.shift();
  }

  list(): OrphanRecord[] {
    return [...this.records];
  }

  get size(): number {
    return this.records.length;
  }
}

/**
 * Best-effort local deletion. Returns true when deleted; on failure records
 * a redacted orphan (ref only, no path contents/provider/secrets) and
 * returns false.
 */
export async function deleteLocalAsset(
  path: string,
  kind: Exclude<RawAssetKind, 'cloud-upload'>,
  deps: { unlink: UnlinkFn; telemetry: OrphanTelemetry },
): Promise<boolean> {
  try {
    await deps.unlink(path);
    return true;
  } catch (error) {
    deps.telemetry.record({
      kind,
      ref: redactRef(path),
      reason: error instanceof Error ? redactReason(error.message) : 'unlink failed',
    });
    return false;
  }
}

/**
 * Cloud-upload deletion attempt. On failure records a redacted orphan so the
 * leak is visible; never throws (cleanup path must not fail the fetch).
 */
export async function deleteCloudUpload(
  uploadRef: string,
  deps: { deleteRemote: DeleteRemoteFn; telemetry: OrphanTelemetry },
): Promise<boolean> {
  try {
    await deps.deleteRemote(uploadRef);
    return true;
  } catch (error) {
    deps.telemetry.record({
      kind: 'cloud-upload',
      ref: redactRef(uploadRef),
      reason: error instanceof Error ? redactReason(error.message) : 'remote delete failed',
    });
    return false;
  }
}

/** Keep only an opaque tail of a path/ref for telemetry (no secrets, no hosts).
 *
 * Strips query/fragment, takes the final path segment, and only passes
 * through safe basenames ([A-Za-z0-9._-], <=64 chars). Anything else
 * (query secrets like `key=abc`, `token=...`, odd characters) collapses to
 * a stable opaque `ref-<hex>` hash so no secret tail leaks. */
export function redactRef(value: string): string {
  const noQuery = value.split(/[?#]/, 1)[0] ?? value;
  const tail = noQuery.split('/').pop() ?? noQuery;
  const base = tail.split('\\').pop() ?? tail;
  if (/^[A-Za-z0-9._-]{1,64}$/.test(base)) return base;
  return `ref-${hashRef(value)}`;
}

/** Stable short hex hash for opaque telemetry refs (djb2, no deps). */
function hashRef(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Scrub an error message for orphan telemetry: strip URLs/paths, redact
 * `key=/token=/secret=`-style fragments, collapse whitespace, cap 200 chars.
 * Telemetry keeps kind + scrubbed reason + timestamp only.
 */
export function redactReason(message: string): string {
  let scrubbed = message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/wss?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[path]')
    .replace(/\/(?:tmp|var|home|Users|etc)\/[^\s"']*/g, '[path]')
    .replace(/((?:api[_-]?key|token|secret|password|bearer|auth|key)\s*[:=]\s*)[^\s;,}"']+/gi, '$1REDACTED')
    .replace(/\s+/g, ' ')
    .trim();
  if (scrubbed.length === 0) return 'delete failed';
  return scrubbed.slice(0, 200);
}

/**
 * Run fn with temp paths registered; every registered local path is
 * deleted in finally (best-effort, orphan-recorded). Usage:
 *   await runWithAssetCleanup(async (scope) => {
 *     const tmp = '/tmp/asset-1'; scope.add(tmp, 'raw-asset'); ...
 *   }, { unlink, telemetry });
 */
export async function runWithAssetCleanup<T>(
  fn: (scope: { add(path: string, kind: Exclude<RawAssetKind, 'cloud-upload'>): void }) => Promise<T>,
  deps: { unlink: UnlinkFn; telemetry: OrphanTelemetry },
): Promise<T> {
  const owned: Array<{ path: string; kind: Exclude<RawAssetKind, 'cloud-upload'> }> = [];
  try {
    return await fn({ add: (path, kind) => { owned.push({ path, kind }); } });
  } finally {
    for (const { path, kind } of owned) {
      await deleteLocalAsset(path, kind, deps);
    }
  }
}

/** 1h TTL check for derived/response entries (preserves WEB_ACCESS_STORE_TTL_MS). */
export function isDerivedEntryExpired(createdAt: number, now: number = Date.now()): boolean {
  return now - createdAt > WEB_ACCESS_STORE_TTL_MS;
}

/** Optional derived-only persistence: env-gated, default-off.
 *
 * DEFERRED-TO-PLAN-D: this seam is flag + TTL cap only — no 0700 root / 0600
 * files / janitor. Plan D owns the persistence implementation.
 */
export function isDerivedPersistenceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PI_ASSET_DERIVED_PERSIST === '1';
}

/**
 * Validate an operator-supplied derived-persistence TTL: ≤24h, else throw.
 * Raw assets are never persisted by this flag.
 */
export function assertDerivedPersistenceTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DERIVED_PERSISTENCE_MAX_TTL_MS) {
    throw new Error(`derived persistence TTL must be in (0, ${DERIVED_PERSISTENCE_MAX_TTL_MS}] ms`);
  }
  return ttlMs;
}
