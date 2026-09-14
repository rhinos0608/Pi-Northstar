// Parent-owned in-memory agent jobs (Plan C3): expiry, owner-bound entries,
// and byte-stable poll snapshots. The opaque Tavily leg stays
// synchronous-inside-job; poll serves the snapshot only.

import { randomUUID } from 'node:crypto';
import {
  AGENT_JOB_TTL_MS,
  canonicalJson,
  type AgentJobV1,
  type AgentResultV1,
} from './agent-contract.js';
import { runAgentCore, type AgentCoreDeps } from './agent-core.js';
import { runAgentReportRoute } from './agent-report-route.js';
import { negotiateAgentRpc, type AgentRpcNegotiationInput } from './agent-rpc.js';

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
}

function expired(job: AgentJobV1, at: number): boolean {
  return at - job.createdAt > AGENT_JOB_TTL_MS;
}

function prune(at: number = store.now()): void {
  for (const [jobId, job] of store.jobs) {
    if (expired(job, at)) store.jobs.delete(jobId);
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

/** Run one job to ready/failed. Tests await this directly; creation kicks it. */
export async function executeAgentJob(jobId: string): Promise<AgentJobV1> {
  const job = store.jobs.get(jobId);
  if (job === undefined) throw new Error(`unknown agent job: ${jobId.slice(0, 32)}`);
  if (job.status !== 'running') return job;
  try {
    const runner = await defaultRunner();
    const result: AgentResultV1 = await runAgentCore(job.query, {
      search: runner.search,
      fetchText: runner.fetchText,
      report: async (query: string) => runAgentReportRoute({ query, env: process.env as Record<string, string | undefined> }),
    } as AgentCoreDeps);
    job.result = result;
    job.status = 'ready';
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }
  job.updatedAt = store.now();
  return job;
}

/** Non-throwing read for embeds that handle absence themselves. */
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
  result?: AgentResultV1;
  error?: string;
}

/**
 * Byte-stable snapshot: canonical JSON, identical bytes for identical job
 * state. Foreign/missing owner on an owned job resolves exactly like a miss
 * (no existence signal, never another owner's bytes).
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
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
  return canonicalJson(snapshot);
}
