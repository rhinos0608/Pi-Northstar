// Shared persistent embedding sidecar lifecycle.
//
// semanticCrawl (src/web.ts) and rankSitemapUrls (src/web-sitemap.ts) used to
// do `new SidecarManager(); await ensureRunning(); ... stop()` per call —
// one Python + SentenceTransformers spawn per query. This module keeps a lazy
// process-wide singleton that survives across calls; callers acquire a handle
// and release it (refcounted, idempotent) instead of stopping the process.
//
// External config bypass: when EMBEDDING_SIDECAR_BASE_URL is set in the
// provided env record, acquire returns that URL with a no-op release and the
// local lifecycle is never touched.
//
// Failure semantics are unchanged: acquire rejects when the sidecar cannot
// start (e.g. Python lacks Torch), and callers fall back to BM25-only
// ranking. Shutdown hooks send SIGTERM synchronously on process exit so the
// child never outlives the CLI worker that started it.

import { SidecarManager } from './sidecar-manager.js';

export type SharedSidecarEnv = Record<string, string | undefined>;

export interface AcquiredSidecar {
  /** Base URL for EmbeddingClient (external URL or local singleton URL). */
  baseUrl: string;
  /** True when an external URL was used and no local process is involved. */
  external: boolean;
  /** Idempotent: decrements the refcount; never stops the process. */
  release(): void;
}

let singleton: SidecarManager | undefined;
let refCount = 0;
let factory: () => SidecarManager = () => new SidecarManager();
let hookInstalled = false;

function onProcessExit(): void {
  // stop() sends SIGTERM synchronously before awaiting exit, so even this
  // floating promise delivers the kill signal; the wait just won't finish.
  void singleton?.stop().catch(() => undefined);
}

function installShutdownHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.once('exit', onProcessExit);
  process.once('SIGINT', onProcessExit);
  process.once('SIGTERM', onProcessExit);
}

function removeShutdownHook(): void {
  if (!hookInstalled) return;
  hookInstalled = false;
  process.removeListener('exit', onProcessExit);
  process.removeListener('SIGINT', onProcessExit);
  process.removeListener('SIGTERM', onProcessExit);
}

function externalBaseUrl(env?: SharedSidecarEnv): string | undefined {
  const raw = env?.EMBEDDING_SIDECAR_BASE_URL ?? process.env.EMBEDDING_SIDECAR_BASE_URL;
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/$/, '');
}

/** Acquire the shared embedding sidecar. Always pair with `release()`. */
export async function acquireEmbeddingSidecar(env?: SharedSidecarEnv): Promise<AcquiredSidecar> {
  const external = externalBaseUrl(env);
  if (external) {
    return { baseUrl: external, external: true, release: () => undefined };
  }
  singleton ??= factory();
  // Rejects on startup failure (e.g. Python without Torch) — refcount is
  // only incremented on success so callers fall back to BM25 with nothing
  // to release.
  await singleton.ensureRunning();
  refCount += 1;
  installShutdownHook();
  let released = false;
  return {
    baseUrl: singleton.getBaseUrl(),
    external: false,
    release: () => {
      if (released) return;
      released = true;
      refCount = Math.max(0, refCount - 1);
    },
  };
}

/** Stop the singleton and clear state. Used by tests and graceful shutdown. */
export async function shutdownSharedSidecar(): Promise<void> {
  refCount = 0;
  removeShutdownHook();
  const manager = singleton;
  singleton = undefined;
  if (manager) await manager.stop().catch(() => undefined);
}

/** @internal Test hook: current refcount. */
export function __sharedSidecarRefCountForTests(): number {
  return refCount;
}

/** @internal Test hook: peek at the singleton without creating it. */
export function __peekSharedSidecarForTests(): SidecarManager | undefined {
  return singleton;
}

/** @internal Test hook: inject a SidecarManager factory (mocked spawn). */
export function __setSharedSidecarFactoryForTests(next: () => SidecarManager): void {
  factory = next;
}

/** @internal Test hook: reset singleton, refcount, factory, and hooks. */
export function __resetSharedSidecarForTests(): void {
  refCount = 0;
  singleton = undefined;
  factory = () => new SidecarManager();
  removeShutdownHook();
}
