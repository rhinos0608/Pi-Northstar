// Parent-owned in-memory agent jobs (Plan C3): expiry, owner-bound entries,
// and byte-stable poll snapshots. The opaque Tavily leg stays
// synchronous-inside-job; poll serves the snapshot only.
//
// Leaf-runtime report leg: when a provider is registered via
// setLeafRuntimeProvider (agent-rpc.ts seam), PI_NORTHSTAR_LEAF_MODEL names
// the exact model (read here at call time, never inside the client), and a
// per-job refreshReady() succeeds, the report leg runs on the leaf runtime.
// Any leaf failure falls back to the opaque leg with a safe-code warning.
// Snapshots carry transport + safe reason only, never provider/model identity.

import { randomUUID } from 'node:crypto';
import {
  AGENT_JOB_TTL_MS,
  canonicalJson,
  type AgentJobV1,
  type AgentResultV1,
} from './agent-contract.js';
import { runAgentCore, redactProvenance, type AgentCoreDeps } from './agent-core.js';
import { runAgentReportRoute, truncateUtf8Bytes } from './agent-report-route.js';
import { AGENT_REPORT_MAX_BYTES } from './agent-contract.js';
import { RUNTIME_RPC_BOUNDS } from '../../runtime/runtime-rpc-protocol.js';
import {
  getLeafRuntimeProvider,
  negotiateAgentRpc,
  type AgentRpcNegotiationInput,
  type LeafRuntimeProvider,
} from './agent-rpc.js';

export interface AgentJobRunnerDeps {
  search(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>>;
  fetchText(url: string): Promise<string>;
}

export interface CreateAgentJobInput {
  query: string;
  owner?: string;
  rpc?: AgentRpcNegotiationInput;
}

interface JobStore {
  jobs: Map<string, AgentJobV1>;
  runner: AgentJobRunnerDeps | undefined;
  now: () => number;
  id: () => string;
}

const store: JobStore = {
  jobs: new Map(),
  runner: undefined,
  now: () => Date.now(),
  id: () => randomUUID(),
};

/** In-flight execution per job: concurrent callers reuse one drive. */
const inFlight = new Map<string, Promise<AgentJobV1>>();

/** Exact env name for the configured leaf model. Read at call time, never in the client. */
export const LEAF_MODEL_ENV_VAR = 'PI_NORTHSTAR_LEAF_MODEL';

/** Per-request leaf timeout: 60s bounded by the protocol maximum. */
export const LEAF_REPORT_TIMEOUT_MS = Math.min(60_000, RUNTIME_RPC_BOUNDS.maxTimeoutMs);

/** Search-constraint fields the job runtime cannot honor: fail closed on every
 *  entry path (seam validator and direct createAgentJobEntry calls alike). */
export const UNSUPPORTED_AGENT_JOB_FIELDS = ['limit', 'category', 'yearFrom', 'recency', 'domains'] as const;

/** Test/embedding seam: inject the search/fetch legs. Unset restores lazy defaults. */
export function setAgentJobRunner(runner: AgentJobRunnerDeps | undefined): void {
  store.runner = runner;
}

/** Test seam: clock + id control. */
export function __setAgentJobClock(now: (() => number) | undefined, id?: (() => string) | undefined): void {
  store.now = now ?? (() => Date.now());
  store.id = id ?? randomUUID;
}

/** Test seam: drain the registry. */
export function __resetAgentJobs(): void {
  store.jobs.clear();
  inFlight.clear();
}

function expired(job: AgentJobV1, at: number): boolean {
  return at - job.createdAt > AGENT_JOB_TTL_MS;
}

function prune(at: number = store.now()): void {
  for (const [jobId, job] of store.jobs) {
    if (expired(job, at)) {
      store.jobs.delete(jobId);
      // TTL expiry drops the drive handle too: a later executeAgentJob call
      // must observe unknown/expired, never a stale settled drive.
      inFlight.delete(jobId);
    }
  }
}

async function defaultRunner(): Promise<AgentJobRunnerDeps> {
  if (store.runner !== undefined) return store.runner;
  // Lazy defaults avoid an import cycle (native-tools never imports agent).
  const [{ callNativeTool }] = await Promise.all([import('../../native-tools.js')]);
  const search = async (query: string): Promise<Array<{ title: string; url: string; snippet?: string }>> => {
    const result = await callNativeTool('web_search', { query, limit: 8 });
    const details = (result as { details?: { results?: Array<{ title?: string; url?: string; snippet?: string }> } }).details;
    return (details?.results ?? [])
      .filter((hit) => typeof hit.url === 'string')
      .map((hit) => ({ title: hit.title ?? hit.url!, url: hit.url!, ...(hit.snippet !== undefined ? { snippet: hit.snippet } : {}) }));
  };
  const fetchText = async (url: string): Promise<string> => {
    const result = await callNativeTool('fetch', { urls: [url] });
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    return (content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
  };
  return { search, fetchText };
}

/** Create + register a job, kick background execution, return the pointer. */
export function createAgentJobEntry(input: CreateAgentJobInput): AgentJobV1 {
  const query = input.query.trim();
  if (query === '') throw new Error('agent job requires a non-empty query');
  // Fail-closed admission on the direct entry path: the runtime takes a bare
  // query string, so search constraints cannot be honored — reject with a
  // static reason before prune/registration instead of dropping silently.
  const record = input as CreateAgentJobInput & Record<string, unknown>;
  for (const field of UNSUPPORTED_AGENT_JOB_FIELDS) {
    if (record[field] !== undefined) {
      throw new Error(`agent job rejects search constraint "${field}": unsupported by the job runtime`);
    }
  }
  prune();
  const at = store.now();
  const job: AgentJobV1 = {
    jobId: store.id(),
    query,
    status: 'running',
    createdAt: at,
    updatedAt: at,
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    rpc: negotiateAgentRpc(input.rpc ?? {}),
  };
  store.jobs.set(job.jobId, job);
  // Sync-inside-job: the Tavily stream + local legs run inside job execution.
  void executeAgentJob(job.jobId).catch(() => {
    // executeAgentJob records failures on the job; this catch only guards
    // against bookkeeping throws escaping into the creator.
  });
  return job;
}

/** Safe leaf failure code: allowlisted token only, never exception text. */
function safeLeafCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) return code;
  return 'provider_error';
}

/**
 * Per-job leaf negotiation: provider registered + model configured + fresh
 * refreshReady() success records transport 'leaf-runtime'; every other path
 * keeps standalone with a precise reason. Snapshots never carry model ids.
 */
async function negotiateLeafTransport(job: AgentJobV1): Promise<LeafRuntimeProvider | undefined> {
  const provider = getLeafRuntimeProvider();
  if (provider === undefined) return undefined;
  const model = (process.env[LEAF_MODEL_ENV_VAR] ?? '').trim();
  if (model === '') {
    job.rpc = {
      attempted: true,
      negotiated: false,
      transport: 'standalone',
      reason: 'leaf runtime registered but leaf model unset; core runs standalone',
    };
    return undefined;
  }
  let ready = false;
  try {
    ready = await provider.refreshReady();
  } catch {
    ready = false;
  }
  if (!ready) {
    job.rpc = {
      attempted: true,
      negotiated: false,
      transport: 'standalone',
      reason: 'leaf runtime refresh failed; core runs standalone',
    };
    return undefined;
  }
  job.rpc = {
    attempted: true,
    negotiated: true,
    transport: 'leaf-runtime',
    reason: 'negotiated exact leaf model',
  };
  return provider;
}

/**
 * Report-leg prompt from already-captured hits: job query + top
 * search-snippet excerpts, bounded to maxPromptBytes. Pure (never calls
 * search): executeAgentJob captures hits once and reuses them for both the
 * core search leg and this prompt, so a leaf job executes one backend
 * search and the prompt matches the attached sources.
 */
export function buildLeafPrompt(
  query: string,
  hits: Array<{ title: string; url: string; snippet?: string }>,
): string {
  const parts = [query];
  for (const hit of hits.slice(0, 5)) {
    const excerpt = `${hit.title ?? ''}\n${hit.snippet ?? ''}`.trim();
    if (excerpt !== '') parts.push(excerpt.slice(0, 500));
  }
  return truncateUtf8Bytes(parts.join('\n\n'), RUNTIME_RPC_BOUNDS.maxPromptBytes);
}

/**
 * Leaf report leg with opaque-leg fallback. On fallback the job snapshot
 * reflects the ACTUAL producer: transport flips to 'standalone' with the
 * safe leaf code in the reason (negotiated stays true — negotiation did
 * happen). On success the negotiated 'leaf-runtime' record stands.
 */
async function leafReportWithFallback(
  job: AgentJobV1,
  query: string,
  prompt: string,
  provider: LeafRuntimeProvider,
): Promise<{ text: string; sources: Array<{ url: string; title: string }>; warnings: string[] }> {
  try {
    // Shutdown-mid-flight guard: the captured provider ref goes stale when
    // shutdownLeafRuntime clears the seam after negotiation. Re-check at use
    // time and abort to the opaque leg instead of driving a dead client.
    if (getLeafRuntimeProvider() === undefined) throw { code: 'provider_shutdown' };
    const out = await provider.runLeaf(prompt, { timeoutMs: LEAF_REPORT_TIMEOUT_MS });
    if (typeof out?.text !== 'string' || out.text.trim() === '') {
      throw { code: 'provider_error' };
    }
    const clean = redactProvenance({ text: out.text });
    const warnings: string[] = [];
    let text = clean.text;
    if (Buffer.byteLength(text, 'utf8') > AGENT_REPORT_MAX_BYTES) {
      text = truncateUtf8Bytes(text, AGENT_REPORT_MAX_BYTES);
      warnings.push(`report text capped to the ${AGENT_REPORT_MAX_BYTES}-byte evidence budget`);
    }
    return { text, sources: [], warnings };
  } catch (error) {
    const code = safeLeafCode(error);
    job.rpc = {
      attempted: true,
      negotiated: true,
      transport: 'standalone',
      reason: `leaf leg failed (${code}); report leg fallback`,
    };
    const leafWarning = `leaf runtime leg failed (${code}); report leg fallback`;
    try {
      const fallback = await runAgentReportRoute({ query, env: process.env as Record<string, string | undefined> });
      return {
        text: fallback.text,
        sources: fallback.sources,
        warnings: [...fallback.warnings, leafWarning],
      };
    } catch {
      // Opaque leg also down: local-evidence result still carries the leaf warning.
      return { text: '', sources: [], warnings: [leafWarning] };
    }
  }
}

/** Run one job to ready/failed. Concurrent callers share one in-flight
 *  drive; the entry clears on settle so later calls observe final status. */
export async function executeAgentJob(jobId: string): Promise<AgentJobV1> {
  const running = inFlight.get(jobId);
  if (running !== undefined) return running;
  const drive = driveWithTimeout(jobId).finally(() => {
    if (inFlight.get(jobId) === drive) inFlight.delete(jobId);
  });
  inFlight.set(jobId, drive);
  return drive;
}

/**
 * Bounded drive: a hung drive fails closed at the job TTL instead of holding
 * the in-flight slot forever. The timeout only rejects the race — the slow
 * drive still settles through the normal catch and records failed.
 */
function driveWithTimeout(jobId: string): Promise<AgentJobV1> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('agent job drive timed out')), AGENT_JOB_TTL_MS);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  });
  const run = driveAgentJob(jobId).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return Promise.race([run, timeout]);
}

/** Single-drive job execution. Never called directly when shared. */
async function driveAgentJob(jobId: string): Promise<AgentJobV1> {
  const job = store.jobs.get(jobId);
  if (job === undefined) throw new Error(`unknown agent job: ${jobId.slice(0, 32)}`);
  if (job.status !== 'running') return job;
  try {
    const runner = await defaultRunner();
    const leaf = await negotiateLeafTransport(job);
    // Single search per job: capture hits once, reuse the same array for
    // the core search leg (memoized one-shot) and the leaf prompt, so the
    // prompt matches the attached sources. The core always runs the local
    // leg, so the capture is always consumed.
    const hits = await runner.search(job.query);
    const report =
      leaf !== undefined
        ? async (query: string) => leafReportWithFallback(job, query, buildLeafPrompt(query, hits), leaf)
        : async (query: string) => runAgentReportRoute({ query, env: process.env as Record<string, string | undefined> });
    const result: AgentResultV1 = await runAgentCore(job.query, {
      search: async () => hits,
      fetchText: runner.fetchText,
      report,
    } as AgentCoreDeps);
    job.result = result;
    job.status = 'ready';
  } catch {
    job.status = 'failed';
    if (job.result === undefined) {
      // Early throw (search leg) with a negotiated leaf transport: no report
      // leg ever produced, so the snapshot resets to standalone with a static
      // reason instead of naming a transport that produced nothing.
      job.rpc = {
        attempted: job.rpc.attempted,
        negotiated: job.rpc.negotiated,
        transport: 'standalone',
        reason: 'job failed before the report leg produced; transport reset to standalone',
      };
    }
    // Stable generic code only: snapshots are model-visible, so dependency
    // messages never land in job.error. No protected diagnostics surface
    // exists — details stay out entirely rather than inventing one.
    job.error = 'agent_job_failed';
  }
  job.updatedAt = store.now();
  return job;
}

/** Non-throwing internal read for embeds that handle absence themselves.
 *  No owner binding by design: the only model-visible surface is
 *  getAgentJobSnapshot (owner-gated, indistinguishable-miss). This read
 *  serves trusted in-process polling only — no caller outside this module
 *  and its tests resolves jobs through it. */
export function getAgentJob(jobId: string): AgentJobV1 | undefined {
  const job = store.jobs.get(jobId);
  if (job === undefined || expired(job, store.now())) return undefined;
  return job;
}

/** True while at least one unexpired job exists (drives poll activation). */
export function hasUnexpiredJob(): boolean {
  prune();
  return store.jobs.size > 0;
}

export interface AgentJobSnapshot {
  jobId: string;
  status: 'running' | 'ready' | 'failed';
  query: string;
  updatedAt: number;
  /** Transport name + safe reason only; never provider or model identity. */
  rpc: { transport: 'standalone' | 'leaf-runtime'; reason: string };
  result?: AgentResultV1;
  error?: string;
}

/**
 * Byte-stable snapshot: canonical JSON, identical bytes for identical job
 * state. Foreign/missing owner on an owned job resolves exactly like a miss
 * (no existence signal, never another owner's bytes). Carries transport +
 * safe reason only — never provider or model identity.
 *
 * NOTE: on running jobs `rpc.transport` names the NEGOTIATED leg, not a
 * produced report — negotiation records 'leaf-runtime' before the report leg
 * runs, and only leafReportWithFallback flips it to the actual producer.
 * `negotiated` stays out of the snapshot by design (the byte-stable contract
 * carries transport + reason only); read the reason for accuracy, never the
 * transport alone.
 */
export function getAgentJobSnapshot(jobId: string, owner?: string): string {
  prune();
  const job = store.jobs.get(jobId);
  if (job === undefined) throw new Error(`unknown or expired agent job: ${jobId.slice(0, 32)}`);
  if (job.owner !== undefined && owner !== job.owner) {
    throw new Error(`unknown or expired agent job: ${jobId.slice(0, 32)}`);
  }
  const snapshot: AgentJobSnapshot = {
    jobId: job.jobId,
    status: job.status,
    query: job.query,
    updatedAt: job.updatedAt,
    rpc: { transport: job.rpc.transport, reason: job.rpc.reason },
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
  return canonicalJson(snapshot);
}
