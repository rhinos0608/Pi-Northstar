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

import { SidecarManager, type SidecarManagerOptions } from './sidecar-manager.js';

export type SharedSidecarEnv = Record<string, string | undefined>;

export interface AcquiredSidecar {
  /** Base URL for EmbeddingClient (external URL or local singleton URL). */
  baseUrl: string;
  /** Local-singleton auth token for EmbeddingClient; undefined on the
   *  external path (client falls back to its existing env-based token). */
  apiToken?: string;
  /** True when an external URL was used and no local process is involved. */
  external: boolean;
  /** Idempotent: decrements the refcount; never stops the process. */
  release(): void;
}

let singleton: SidecarManager | undefined;
let refCount = 0;
let factory: (env?: SharedSidecarEnv) => SidecarManager = (env) => new SidecarManager(resolveLocalManagerOptions(env));
let hookInstalled = false;

/** Bounded wait for signal-driven cleanup before explicit exit. Covers
 *  SidecarManager.stop()'s SIGKILL grace (5s) plus its exit-wait safety net:
 *  a shorter bound would process.exit() after SIGTERM but before the SIGKILL
 *  timer fires, orphaning the child. */
const SIGNAL_CLEANUP_TIMEOUT_MS = 7000;

function onProcessExit(): void {
  // 'exit' handlers run synchronously: stop() issues SIGTERM synchronously
  // before its first await, so even this floating promise kills the child.
  void singleton?.stop().catch(() => undefined);
}

function onSigint(): void {
  void handleSignalShutdown(130);
}

function onSigterm(): void {
  void handleSignalShutdown(143);
}

async function handleSignalShutdown(exitCode: number): Promise<void> {
  // Drop all hooks first: restores default disposition, no re-entry.
  removeShutdownHook();
  try {
    await Promise.race([
      singleton?.stop() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, SIGNAL_CLEANUP_TIMEOUT_MS)),
    ]);
  } catch {
    // Best-effort cleanup only.
  }
  process.exit(exitCode);
}

function installShutdownHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.once('exit', onProcessExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
}

function removeShutdownHook(): void {
  if (!hookInstalled) return;
  hookInstalled = false;
  process.removeListener('exit', onProcessExit);
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
}

function readSidecarEnvValue(env: SharedSidecarEnv | undefined, key: string): string | undefined {
  const trimmed = (env?.[key] ?? process.env[key])?.trim();
  return trimmed ? trimmed : undefined;
}

/** Translate discovery env into local launch options so a locally launched
 *  sidecar uses the same config observers set for discovery.
 *  PI_SEARCH_EMBEDDING_DIMENSIONS is intentionally not a spawn arg:
 *  sidecar/app.py derives dimensions from the model (no --dimensions flag);
 *  /v1/health reports the actual dims. */
function resolveLocalManagerOptions(env?: SharedSidecarEnv): SidecarManagerOptions {
  const options: SidecarManagerOptions = {};
  const model = readSidecarEnvValue(env, 'PI_SEARCH_EMBEDDING_MODEL');
  if (model) options.model = model;
  const device = readSidecarEnvValue(env, 'SIDECAR_DEVICE');
  if (device) options.device = device;
  const portRaw = readSidecarEnvValue(env, 'PI_SEARCH_EMBEDDING_PORT');
  if (portRaw !== undefined) {
    const port = Number(portRaw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) options.port = port;
  }
  return options;
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
  singleton ??= factory(env);
  // Capture the instance before the startup await: a concurrent
  // shutdownSharedSidecar() during ensureRunning() clears the module
  // singleton, so re-reading it after the await could dereference a stale
  // or undefined manager. Reject stale acquisition instead.
  const candidate = singleton;
  await candidate.ensureRunning();
  if (singleton !== candidate) {
    throw new Error('shared sidecar changed during startup; retry acquisition');
  }
  refCount += 1;
  installShutdownHook();
  let released = false;
  const apiToken = candidate.getAuthToken();
  return {
    baseUrl: candidate.getBaseUrl(),
    ...(apiToken !== undefined ? { apiToken } : {}),
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
  factory = (env) => new SidecarManager(resolveLocalManagerOptions(env));
  removeShutdownHook();
}
