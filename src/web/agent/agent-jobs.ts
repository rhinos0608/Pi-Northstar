// Parent-owned in-memory agent jobs (Plan C3): expiry, owner-bound entries,
// and byte-stable poll snapshots. The adaptive core runs synchronous-
// inside-job; poll serves the snapshot only.
//
// Leaf-runtime steering: when a provider is registered via
// setLeafRuntimeProvider (agent-rpc.ts seam), PI_NORTHSTAR_LEAF_MODEL names
// the exact model (read here at call time, never inside the client), and a
// per-job refreshReady() succeeds, planner/evaluator/synthesizer/verifier/
// repair steer through the leaf runtime. Leaf seam failures degrade to the
// deterministic ladder with fixed safe reasons. Snapshots carry transport +
// safe reason only, never provider/model identity.

import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  validateAgentResult,
  AGENT_WARNING_MAX_BYTES,
  type AgentJobV1,
  type AgentResultV1,
} from './agent-contract.js';
import { runAgentCore, AgentDeadlineError, DEADLINE_MESSAGE, type AgentCoreDeps, type AgentProgressDetail } from './agent-core.js';
import { snapshotForJob } from './agent-capabilities.js';
import { createAgentModelSeams } from './agent-model.js';
import { sanitizeEvaluatorQuery } from './agent-evaluator.js';
import { truncateUtf8Bytes } from './agent-report-route.js';
import {
  AGENT_POLL_VISIBILITY_TTL_MS,
  AGENT_RESULT_RETENTION_TTL_MS,
  AGENT_RUN_DEADLINE_MAX_MS,
  AGENT_RUN_DEADLINE_MS,
} from './agent-contract.js';
import {
  AGENT_EVENT_QUERY_MAX_BYTES,
  createAgentEventJournal,
  type AgentEventJournal,
  type AgentResearchEvent,
} from './agent-events.js';
import {
  getLeafRuntimeProvider,
  negotiateAgentRpc,
  type AgentRpcNegotiationInput,
  type AgentRpcRecord,
  type LeafRuntimeProvider,
} from './agent-rpc.js';

export interface AgentJobRunnerDeps {
  search(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>>;
  fetchText(url: string): Promise<string>;
  /** Optional global sink default: per-job sinks win. Function-only, never serialized. */
  eventSink?: (event: AgentResearchEvent) => void;
}

export type AgentJobDepth = 'balanced' | 'deep';

export interface CreateAgentJobInput {
  query: string;
  owner?: string;
  rpc?: AgentRpcNegotiationInput;
  /** Optional job depth: explicit 'deep' selects the deep gather profile;
   *  absent (or 'balanced') keeps the balanced default with deterministic
   *  narrow refinement. Rejects any other value, never clamps. */
  depth?: AgentJobDepth;
  /** Optional run deadline (ms): enforced by the drive race + controller.
   *  Rejects past AGENT_RUN_DEADLINE_MAX_MS, never clamps. Absent = default. */
  deadlineMs?: number;
  /** Optional caller abort: forwarded to the controller when set. */
  signal?: AbortSignal;
  /** Optional per-job sink: forwarded journal appends, best-effort. Function-only, never serialized. */
  eventSink?: (event: AgentResearchEvent) => void;
}

/** Per-call drive overrides. A valid deadline persists on the job. */
export interface ExecuteAgentJobOptions {
  deadlineMs?: number;
  /** Optional job depth override (persists like deadlineMs). */
  depth?: AgentJobDepth;
  signal?: AbortSignal;
  /** Optional per-job sink override (persists like deadlineMs). Function-only, never serialized. */
  eventSink?: (event: AgentResearchEvent) => void;
}

/** Fail-closed event-sink admission: function-only, never serialized.
 *  Present-but-not-a-function rejects (consistent with deadlineMs). */
function validateEventSink(value: unknown): ((event: AgentResearchEvent) => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw new TypeError('eventSink must be a function');
  return value as (event: AgentResearchEvent) => void;
}

/** Reject-not-clamp depth validation (budgets pattern). Absent = balanced default. */
function validateDepth(depth: unknown): AgentJobDepth | undefined {
  if (depth === undefined) return undefined;
  if (depth !== 'balanced' && depth !== 'deep') {
    throw new RangeError('depth must be "balanced" or "deep"');
  }
  return depth;
}

/** Reject-not-clamp deadline validation (budgets pattern). */
function validateDeadlineMs(deadlineMs: number | undefined): number | undefined {
  if (deadlineMs === undefined) return undefined;
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError('deadlineMs must be greater than 0');
  }
  if (deadlineMs > AGENT_RUN_DEADLINE_MAX_MS) {
    throw new RangeError(`deadlineMs exceeds maximum of ${AGENT_RUN_DEADLINE_MAX_MS}`);
  }
  return deadlineMs;
}

function mergeProgress(jobId: string, event: AgentProgressEvent): void {
  const prior = jobProgress.get(jobId);
  const base: AgentJobProgress = prior ?? {
    stage: 'plan',
    round: 0,
    questionsAnswered: 0,
    questionsTotal: 0,
    searchesUsed: 0,
    fetchesUsed: 0,
  };
  const count = (value: number | undefined, fallback: number): number =>
    typeof value !== 'number' || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
  const stage = event.stage !== undefined && AGENT_JOB_STAGES.has(event.stage) ? event.stage : base.stage;
  // Additive usage count: mapped when the core reports it, preserved across
  // boundaries that omit it, absent when never sent (byte-compat snapshots).
  const utility = asCount(event.utilityCallsUsed) ?? base.utilityCallsUsed;
  jobProgress.set(jobId, {
    stage,
    round: count(event.round, base.round),
    questionsAnswered: count(event.questionsAnswered, base.questionsAnswered),
    questionsTotal: count(event.questionsTotal, base.questionsTotal),
    searchesUsed: count(event.searchesUsed, base.searchesUsed),
    fetchesUsed: count(event.fetchesUsed, base.fetchesUsed),
    ...(utility !== undefined ? { utilityCallsUsed: utility } : {}),
  });
}

function markProgressSettled(jobId: string, stage: 'done' | 'failed'): void {
  const prior = jobProgress.get(jobId);
  if (prior === undefined) return;
  jobProgress.set(jobId, { ...prior, stage });
}

/** Test seam: script a job progress projection (steps stages deterministically
 *  without a live core). Undefined clears the projection (absent-seam shape). */
export function __setAgentJobProgress(jobId: string, progress: AgentJobProgress | undefined): void {
  if (progress === undefined) {
    jobProgress.delete(jobId);
    return;
  }
  jobProgress.set(jobId, { ...progress });
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

/** Exact env name for the no-model steering kill-switch. Read at call time,
 *  same convention as LEAF_MODEL_ENV_VAR. Exact '0' runs the deterministic
 *  ladder without model calls. */
export const AGENT_STEERING_ENV_VAR = 'PI_NORTHSTAR_AGENT_STEERING';

/** No-model ladder selector (Task 3): exact '0' disables steering.
 *  Any other value (including absent) keeps steering enabled. */
export function isAgentSteeringDisabled(env: Record<string, string | undefined>): boolean {
  return env[AGENT_STEERING_ENV_VAR] === '0';
}

/** Strip every model-call dep so the job runs the deterministic ladder:
 *  root-plan fallback (planner absent), deterministic stop conditions
 *  (evaluator absent), evidence-only composition (synthesizer absent), skipped
 *  verify/repair (absent). Non-model deps pass through untouched. */
export function stripAgentModelDeps(deps: AgentCoreDeps): AgentCoreDeps {
  const stripped: AgentCoreDeps = { ...deps };
  delete stripped.planner;
  delete stripped.evaluator;
  delete stripped.synthesizer;
  delete stripped.verifier;
  delete stripped.repairer;
  delete stripped.utilityModelClient;
  return stripped;
}

/** Search-constraint fields the job runtime cannot honor: fail closed on every
 *  entry path (seam validator and direct createAgentJobEntry calls alike). */
export const UNSUPPORTED_AGENT_JOB_FIELDS = ['limit', 'category', 'yearFrom', 'recency', 'domains'] as const;

/** Test/embedding seam: inject the search/fetch legs. Unset restores lazy defaults. */
export function setAgentJobRunner(runner: AgentJobRunnerDeps | undefined): void {
  store.runner = runner;
}

/** Phase 6 lifecycle split (roadmap row 6, Revision 2 R6): the old single
 *  AGENT_JOB_TTL_MS conflated three concepts. Canonical home is
 *  agent-contract.ts (single source; AGENT_JOB_TTL_MS derives as the max).
 *  Re-exported here for compat (including the derived AGENT_JOB_TTL_MS
 *  max); per-concept expiry below uses the SPLIT constants, never the
 *  derived max. */
export {
  AGENT_JOB_TTL_MS,
  AGENT_POLL_VISIBILITY_TTL_MS,
  AGENT_RESULT_RETENTION_TTL_MS,
  AGENT_RUN_DEADLINE_MAX_MS,
  AGENT_RUN_DEADLINE_MS,
} from './agent-contract.js';

/** Progress stages (roadmap Phase 6 shape): counts only, never model or
 *  provider identity, no goal text beyond the already-public query. */
export type AgentJobStage = 'plan' | 'gather' | 'evaluate' | 'synthesize' | 'verify' | 'done' | 'failed';

const AGENT_JOB_STAGES: ReadonlySet<string> = new Set(['plan', 'gather', 'evaluate', 'synthesize', 'verify', 'done', 'failed']);

/** Core → jobs progress event (forward-compat: runAgentCore ignores unknown
 *  deps until the core seam lands; the jobs shell already honors it). */
export interface AgentProgressEvent {
  stage?: AgentJobStage;
  round?: number;
  questionsAnswered?: number;
  questionsTotal?: number;
  searchesUsed?: number;
  fetchesUsed?: number;
  /** Forward-compat: the core seam may propagate model-call usage here.
   *  Accepted and ignored by the journal mapping (no event carries it). */
  utilityCallsUsed?: number;
  /** Journal-fidelity detail (todo #14): real ids/counts from the core.
   *  Absent = legacy journal mapping (synthetic plan ids, stage-time zeros,
   *  no EvidenceAdmitted). Never serialized into snapshots. */
  detail?: AgentProgressDetail;
}

/** Settled per-job progress projection: every field always present once the
 *  object exists (fixed order, canonicalJson sorts keys — byte-stable). */
export interface AgentJobProgress {
  stage: AgentJobStage;
  round: number;
  questionsAnswered: number;
  questionsTotal: number;
  searchesUsed: number;
  fetchesUsed: number;
  /** Additive model-call usage; absent when the core never reported it. */
  utilityCallsUsed?: number;
}

/** Per-job progress projections (absent = core reported nothing: snapshot
 *  omits the field, byte-identical to pre-Phase-6 snapshots). */
const jobProgress = new Map<string, AgentJobProgress>();

/** Per-job configured run deadlines (create or execute opts; else default). */
const jobDeadlines = new Map<string, number>();

/** Per-job configured depth (create or execute opts; else balanced default). */
const jobDepths = new Map<string, AgentJobDepth>();

/** Phase 7: per-job typed event journals (internal state, never in snapshots).
 *  Live mutable state stays authoritative; the journal is a replayable shadow.
 *  Absent journal (rejected factory id) = emissions no-op, behavior unchanged. */
const jobJournals = new Map<string, AgentEventJournal>();

/** Phase 7: per-job event sinks (allowlist-constructed fns only, never serialized). */
const jobSinks = new Map<string, (event: AgentResearchEvent) => void>();

const asCount = (value: number | undefined): number | undefined =>
  typeof value !== 'number' || !Number.isFinite(value) ? undefined : Math.max(0, Math.floor(value));

/** Get-or-create the journal for a job. Rejected factory ids yield undefined. */
function getOrCreateJournal(jobId: string): AgentEventJournal | undefined {
  const existing = jobJournals.get(jobId);
  if (existing !== undefined) return existing;
  const created = createAgentEventJournal(jobId);
  if ('rejected' in created) return undefined;
  jobJournals.set(jobId, created);
  return created;
}

function resolveJobSink(jobId: string): ((event: AgentResearchEvent) => void) | undefined {
  const stored = jobSinks.get(jobId);
  if (stored !== undefined) return stored;
  const fallback = store.runner?.eventSink;
  return typeof fallback === 'function' ? fallback : undefined;
}

/** Best-effort journal append + sink forward. Never throws, never fails the drive. */
function emitJournalEvent(jobId: string, event: AgentResearchEvent): void {
  try {
    const journal = jobJournals.get(jobId);
    if (journal === undefined) return;
    const appended = journal.append(event);
    if (!appended.ok) return;
    const sink = resolveJobSink(jobId);
    if (sink === undefined) return;
    try {
      sink(event);
    } catch {
      // Best-effort: sink observers never fail the drive.
    }
  } catch {
    // Best-effort: journal observers never fail the drive.
  }
}

const journalHasType = (journal: AgentEventJournal, type: AgentResearchEvent['type']): boolean =>
  journal.events.some((entry) => entry.type === type);

const journalMaxCounter = (
  journal: AgentEventJournal,
  type: 'SearchCompleted' | 'FetchCompleted',
): number => {
  let max = 0;
  for (const entry of journal.events) {
    if (type === 'SearchCompleted' && entry.type === 'SearchCompleted' && entry.searchesUsed > max) {
      max = entry.searchesUsed;
    }
    if (type === 'FetchCompleted' && entry.type === 'FetchCompleted' && entry.fetchesUsed > max) {
      max = entry.fetchesUsed;
    }
  }
  return max;
};

/** Journal fidelity (todo #14): admit-batch detail → EvidenceAdmitted events.
 *  Emits one event per entry in record order. Only runs when the core
 *  supplies detail (absent = legacy: no EvidenceAdmitted, byte-identical).
 *  Invalid entries reject at journal.append (best-effort, never throws). */
function emitEvidenceAdmitted(jobId: string, event: AgentProgressEvent, round: number): void {
  try {
    const batch = event.detail?.admittedEvidence;
    if (!Array.isArray(batch) || batch.length === 0) return;
    for (const entry of batch) {
      if (typeof entry !== 'object' || entry === null) continue;
      const detail = entry as { id?: unknown; questionIds?: unknown; excerptHash?: unknown; fingerprint?: unknown };
      if (typeof detail.id !== 'string' || typeof detail.excerptHash !== 'string' || typeof detail.fingerprint !== 'string') continue;
      if (!Array.isArray(detail.questionIds)) continue;
      emitJournalEvent(jobId, {
        type: 'EvidenceAdmitted',
        jobId,
        evidenceId: detail.id,
        round,
        questionIds: [...(detail.questionIds as string[])],
        excerptHash: detail.excerptHash,
        fingerprint: detail.fingerprint,
      });
    }
  } catch {
    // Best-effort: journal observers never fail the drive.
  }
}

/** Deterministic placeholder question ids: legacy fallback when the core
 *  progress detail carries no usable planQuestionIds (todo #14).
 *  Stable per (total, index); match the journal QUESTION_ID_PATTERN. */
function syntheticQuestionIds(total: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < total; index += 1) {
    ids.push(`q-${(index + 1).toString(16).padStart(8, '0')}`);
  }
  return ids;
}

/** Sanitize then truncate a journal query field: control-strip first so the
 *  byte cap measures the emitted text, never truncate-then-leak controls. */
function journalQueryField(value: string): string {
  return truncateUtf8Bytes(sanitizeEvaluatorQuery(value), AGENT_EVENT_QUERY_MAX_BYTES);
}

/** Deterministic result-warning formats the core emits (see agent-core
 *  trySynthesizeFromIR / tryVerifyAndRepair). Parsed for real journal
 *  counts; anything else means unknown, never zero-fill. */
const SYNTHESIS_IR_MARKER = 'synthesis from evidence IR';
const SYNTHESIS_DROPS_PATTERN = /^synthesis drops: claimUnits=(\d+) blocks=(\d+) orphaned=(\d+)$/;
const VERIFICATION_PATTERN = /^verification: (\d+) supported, (\d+) refuted, (\d+) without enough evidence$/;
const REPAIR_APPLIED_PATTERN = /^repair applied: (\d+) claims re-supported$/;
const REPAIR_REJECTED_PREFIX = 'repair rejected';

const asSafeCount = (text: string): number | undefined => {
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const SYNTHESIS_ORPHANED_CITATIONS_PREFIX = 'synthesis orphaned citations:';

/** Count of citation orphans on the second synthesis line (comma-separated ids).
 *  Last matching line wins; absent line = unknown (undefined, never zero-fill).
 *  Present-but-empty payload counts 0. */
export function parseSynthesisOrphanedCitationsWarning(warnings: readonly string[]): number | undefined {
  let found: number | undefined;
  for (const warning of warnings) {
    if (typeof warning !== 'string') continue;
    const trimmed = warning.trim();
    if (!trimmed.startsWith(SYNTHESIS_ORPHANED_CITATIONS_PREFIX)) continue;
    const payload = trimmed.slice(SYNTHESIS_ORPHANED_CITATIONS_PREFIX.length).trim();
    found = payload === '' ? 0 : payload.split(',').filter((part) => part.trim() !== '').length;
  }
  return found;
}

/** Last matching drops line wins (single synthesis pass: at most one). */
export function parseSynthesisDropsWarning(warnings: readonly string[]):
  { claimUnits: number; blocks: number; orphaned: number } | undefined {
  let found: { claimUnits: number; blocks: number; orphaned: number } | undefined;
  for (const warning of warnings) {
    if (typeof warning !== 'string') continue;
    const match = SYNTHESIS_DROPS_PATTERN.exec(warning.trim());
    if (match === null) continue;
    const claimUnits = asSafeCount(match[1] as string);
    const blocks = asSafeCount(match[2] as string);
    const orphaned = asSafeCount(match[3] as string);
    if (claimUnits === undefined || blocks === undefined || orphaned === undefined) continue;
    found = { claimUnits, blocks, orphaned };
  }
  return found;
}

/** Last matching verification triplet wins (single verify pass: at most one). */
export function parseVerificationWarning(warnings: readonly string[]):
  { supported: number; refuted: number; unsupported: number } | undefined {
  let found: { supported: number; refuted: number; unsupported: number } | undefined;
  for (const warning of warnings) {
    if (typeof warning !== 'string') continue;
    const match = VERIFICATION_PATTERN.exec(warning.trim());
    if (match === null) continue;
    const supported = asSafeCount(match[1] as string);
    const refuted = asSafeCount(match[2] as string);
    const unsupported = asSafeCount(match[3] as string);
    if (supported === undefined || refuted === undefined || unsupported === undefined) continue;
    found = { supported, refuted, unsupported };
  }
  return found;
}

/** Last matching repair-applied line wins (single repair pass: at most one). */
export function parseRepairAppliedWarning(warnings: readonly string[]): number | undefined {
  let found: number | undefined;
  for (const warning of warnings) {
    if (typeof warning !== 'string') continue;
    const match = REPAIR_APPLIED_PATTERN.exec(warning.trim());
    if (match === null) continue;
    const count = asSafeCount(match[1] as string);
    if (count === undefined) continue;
    found = count;
  }
  return found;
}

/** Count of deterministic repair-rejected lines (skips are not rejections). */
export function countRepairRejectedWarnings(warnings: readonly string[]): number {
  let count = 0;
  for (const warning of warnings) {
    if (typeof warning === 'string' && warning.startsWith(REPAIR_REJECTED_PREFIX)) count += 1;
  }
  return count;
}

/** Map an onProgress stage boundary to typed journal events.
 *  Gather deltas (searchesUsed/fetchesUsed vs journal maxes) emit one
 *  SearchCompleted/FetchCompleted per new count, using the wrapped
 *  search/fetch logs for exact query/hitCount/url/byteLength; both logs are
 *  record-ordered (slots reserved at CALL time, settled in place — see
 *  wrappedSearch/wrappedFetch), so completion order can never skew the
 *  journal and failures log failed:true instead of gaps. Deltas run on every
 *  stage but plan (a failed search skips its gather progress, so a later
 *  boundary backfills successes and drains failed slots in record order;
 *  plan stays first so PlanAccepted keeps its position). Failed slots emit
 *  failed:true with their logged query, never a fabricated fallback.
 *  Synth/verify counts are unknowable at progress time (the core fires
 *  those stages before the result exists), so this mapping emits nothing
 *  for them — unknown omits, never zero-fills (see
 *  emitResultJournalCounts). Failures emit nothing: no JobReady (journal
 *  stays incomplete = replayable). Best-effort throughout: never throws. */
function emitProgressJournal(args: {
  jobId: string;
  jobQuery: string;
  event: AgentProgressEvent;
  searchLog: Array<{ query: string; hitCount: number; failed?: boolean }>;
  fetchLog: Array<{ canonicalUrl: string; byteLength: number; failed?: boolean }>;
}): void {
  try {
    const { jobId, jobQuery, event, searchLog, fetchLog } = args;
    const journal = getOrCreateJournal(jobId);
    if (journal === undefined || event.stage === undefined) return;
    const round = asCount(event.round) ?? 0;
    const fallbackQuery = journalQueryField(jobQuery);
    // Record-order drain on every post-plan boundary (idempotent via the
    // journal maxes): the count covers merged legs while the log covers
    // backend calls, so extra settled slots (a failed live search, a
    // capture-served leg) drain here in call order with ledger counters.
    if (event.stage !== 'plan') {
      const searches = asCount(event.searchesUsed);
      if (searches !== undefined) {
        const target = Math.max(searches, searchLog.length);
        for (let k = journalMaxCounter(journal, 'SearchCompleted'); k < target; k += 1) {
          const logged = searchLog[k];
          if (logged === undefined) {
            emitJournalEvent(jobId, {
              type: 'SearchCompleted',
              jobId,
              round,
              query: fallbackQuery,
              hitCount: 0,
              searchesUsed: k + 1,
            });
            continue;
          }
          emitJournalEvent(jobId, {
            type: 'SearchCompleted',
            jobId,
            round,
            query: journalQueryField(logged.query),
            hitCount: logged.hitCount,
            searchesUsed: k + 1,
            ...(logged.failed === true ? { failed: true as const } : {}),
          });
        }
      }
      const fetches = asCount(event.fetchesUsed);
      if (fetches !== undefined) {
        for (let k = journalMaxCounter(journal, 'FetchCompleted'); k < fetches; k += 1) {
          const logged = fetchLog[k];
          if (logged === undefined) continue;
          emitJournalEvent(jobId, {
            type: 'FetchCompleted',
            jobId,
            round,
            canonicalUrl: logged.canonicalUrl,
            byteLength: logged.byteLength,
            fetchesUsed: k + 1,
            ...(logged.failed === true ? { failed: true as const } : {}),
          });
        }
      }
    }
    if (event.stage === 'plan') {
      if (journalHasType(journal, 'PlanAccepted')) return;
      const total = asCount(event.questionsTotal) ?? 0;
      // Journal fidelity (todo #14): real question ids ride the progress
      // detail; synthetic placeholders only when detail is absent or
      // unusable (legacy mapping, byte-identical to before).
      const detailIds = event.detail?.planQuestionIds;
      const useReal =
        Array.isArray(detailIds) &&
        detailIds.length === total &&
        detailIds.every((id) => typeof id === 'string');
      emitJournalEvent(jobId, {
        type: 'PlanAccepted',
        jobId,
        questionsTotal: total,
        questionIds: useReal ? [...(detailIds as string[])] : syntheticQuestionIds(total),
        scopeNoteCount: 0,
      });
      return;
    }
    if (event.stage === 'gather') {
      // Leg deltas already drained above (record order, all post-plan stages).
      // Journal fidelity (todo #14): admitted batch → EvidenceAdmitted events.
      emitEvidenceAdmitted(jobId, event, round);
      // Count-only candidate telemetry: one CandidatesAccumulated per gather
      // boundary when the core reports accounting. Reject-never-clamp: both
      // fields must be non-negative integers or nothing emits (no zero-fill,
      // no asCount clamping — a malformed detail never becomes journal bytes).
      const candidatesAdded = event.detail?.candidatesAdded;
      const candidatesDropped = event.detail?.candidatesDropped;
      if (
        typeof candidatesAdded === 'number' && Number.isInteger(candidatesAdded) && candidatesAdded >= 0 &&
        typeof candidatesDropped === 'number' && Number.isInteger(candidatesDropped) && candidatesDropped >= 0
      ) {
        emitJournalEvent(jobId, {
          type: 'CandidatesAccumulated',
          jobId,
          round,
          added: candidatesAdded,
          dropped: candidatesDropped,
        });
      }
      return;
    }
    if (event.stage === 'evaluate') {
      // Journal fidelity (todo #14): real stage-time counts ride the
      // detail; absent = legacy mapping (state-count answered, zero
      // next/dropped — byte-identical to before).
      const detail = event.detail;
      emitJournalEvent(jobId, {
        type: 'EvaluationAccepted',
        jobId,
        round,
        answeredCount: detail?.evaluationAnswered ?? asCount(event.questionsAnswered) ?? 0,
        nextQueryCount: detail?.evaluationNextQueries ?? 0,
        droppedNextQueries: detail?.evaluationDropped ?? 0,
      });
      emitEvidenceAdmitted(jobId, event, round);
      return;
    }
    // synthesize/verify: counts unknowable until the result exists — omit
    // here (never zero-fill); emitResultJournalCounts threads real counts
    // post-result from the deterministic warning formats, or omits when
    // the seams did not run.
    // done/failed: no journal event here (JobReady emitted by the driver on
    // success; failures leave the journal incomplete = not JobReady-terminated).
  } catch {
    // Best-effort: journal observers never fail the drive.
  }
}

/** Post-result synth/verify journal counts from the deterministic result
 *  warnings (never the zero-fill progress mapping, which is stage-time).
 *  SynthesisCompleted emits only when the IR marker proves the synthesizer
 *  ran: claimUnitCount is the shipped claim units (exact), orphanedCount
 *  the parsed drops orphaned (0 when the marker is present but no drops
 *  line), blockCount the rendered prose blocks (the IR renderer joins one
 *  prose per block with blank lines). VerificationCompleted emits only
 *  when the verification triplet parses; repair counts default 0 with
 *  parsed overrides (no repair attempt is really 0/0). Anything else
 *  omits the event rather than emitting zeros. Idempotent via
 *  journalHasType guards. Best-effort: never throws. */
function emitResultJournalCounts(jobId: string, result: AgentResultV1): void {
  try {
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const claims = Array.isArray(result.claims) ? result.claims : [];
    const journal = jobJournals.get(jobId);
    if (journal === undefined) return;
    if (warnings.includes(SYNTHESIS_IR_MARKER) && !journalHasType(journal, 'SynthesisCompleted')) {
      const drops = parseSynthesisDropsWarning(warnings);
      // Orphaned total folds both lines: drops-line orphaned blocks plus
      // citation orphans; either line unknown omits its portion (never zero-fill).
      const orphanedCount =
        (drops?.orphaned ?? 0) + (parseSynthesisOrphanedCitationsWarning(warnings) ?? 0);
      const reportText = typeof result.reportText === 'string' ? result.reportText : '';
      const blockCount = reportText.split('\n\n').filter((part) => part.trim() !== '').length;
      emitJournalEvent(jobId, {
        type: 'SynthesisCompleted',
        jobId,
        claimUnitCount: claims.length,
        blockCount,
        orphanedCount,
      });
    }
    const verification = parseVerificationWarning(warnings);
    if (verification !== undefined && !journalHasType(journal, 'VerificationCompleted')) {
      emitJournalEvent(jobId, {
        type: 'VerificationCompleted',
        jobId,
        supportedCount: verification.supported,
        refutedCount: verification.refuted,
        unsupportedCount: verification.unsupported,
        repairApplied: parseRepairAppliedWarning(warnings) ?? 0,
        repairRejected: countRepairRejectedWarnings(warnings),
      });
    }
  } catch {
    // Best-effort: journal observers never fail the drive.
  }
}

/** Test seam: owner-gated journal read (internal state for tests + future resume).
 *  Mirrors snapshot gating: unknown/expired ids and foreign owners read as misses. */
export function __getAgentEventJournal(jobId: string, owner?: string): AgentEventJournal | undefined {
  prune();
  const job = store.jobs.get(jobId);
  if (job === undefined) throw new Error(`unknown or expired agent job: ${jobId.slice(0, 32)}`);
  if (job.owner !== undefined && owner !== job.owner) {
    throw new Error(`unknown or expired agent job: ${jobId.slice(0, 32)}`);
  }
  return jobJournals.get(jobId);
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
  jobProgress.clear();
  jobDeadlines.clear();
  jobDepths.clear();
  jobJournals.clear();
  jobSinks.clear();
}

function expired(job: AgentJobV1, at: number): boolean {
  // Per-concept expiry: running jobs die past the run deadline; terminal jobs
  // stay pollable until the retention TTL passes. Visibility staleness is
  // never expiry — see isAgentJobSnapshotStale.
  if (job.status === 'running') return at - job.createdAt > (jobDeadlines.get(job.jobId) ?? AGENT_RUN_DEADLINE_MS);
  return at - job.updatedAt > AGENT_RESULT_RETENTION_TTL_MS;
}

function prune(at: number = store.now()): void {
  for (const [jobId, job] of store.jobs) {
    if (expired(job, at)) {
      store.jobs.delete(jobId);
      // Expiry drops the drive handle too: a later executeAgentJob call must
      // observe unknown/expired, never a stale settled drive.
      inFlight.delete(jobId);
      jobProgress.delete(jobId);
      jobDeadlines.delete(jobId);
      jobDepths.delete(jobId);
      jobJournals.delete(jobId);
      jobSinks.delete(jobId);
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
  // Fail-closed sink admission before prune/registration: a present-but-wrong
  // sink registers no job (the validated sink is reused at set-site below).
  const sink = validateEventSink(input.eventSink);
  // Fail-closed admission on the direct entry path: the runtime takes a bare
  // query string, so search constraints cannot be honored — reject with a
  // static reason before prune/registration instead of dropping silently.
  const record = input as CreateAgentJobInput & Record<string, unknown>;
  for (const field of UNSUPPORTED_AGENT_JOB_FIELDS) {
    if (record[field] !== undefined) {
      throw new Error(`agent job rejects search constraint "${field}": unsupported by the job runtime`);
    }
  }
  // Fail-closed depth admission before prune/registration: an invalid value
  // registers no job (consistent with the event-sink gate above).
  const depth = validateDepth(record['depth']);
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
  const deadlineMs = validateDeadlineMs(input.deadlineMs);
  if (deadlineMs !== undefined) jobDeadlines.set(job.jobId, deadlineMs);
  if (depth !== undefined) jobDepths.set(job.jobId, depth);
  if (sink !== undefined) jobSinks.set(job.jobId, sink);
  // Phase 7: journal opens at creation; JobCreated first (best-effort, never fails admission).
  getOrCreateJournal(job.jobId);
  emitJournalEvent(job.jobId, {
    type: 'JobCreated',
    jobId: job.jobId,
    query: journalQueryField(query),
    createdAtMs: Math.max(0, Math.floor(at)),
  });
  // Sync-inside-job: the Tavily stream + local legs run inside job execution.
  void executeAgentJob(job.jobId, {
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }).catch(() => {
    // executeAgentJob records failures on the job; this catch only guards
    // against bookkeeping throws escaping into the creator.
  });
  return job;
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
    ...negotiatedLeafCaps(provider),
  };
  return provider;
}

/** Negotiated capability ceilings into the record (fail-closed admission
 *  shape): ownerPattern 256B, roles 16 entries x 64B. Unbounded provider
 *  strings never land in AgentRpcRecord.
 *
 * Record-level negotiated caps (outputModes + correlationV2 + jsonSchema)
 * from providers that surface them. Absent on v1-only providers — no fields
 * added, legacy record shape untouched. Snapshots never carry these
 * (transport+reason only). Observability only — no gating change.
 */
const NEGOTIATED_OWNER_PATTERN_MAX_BYTES = 256;
const NEGOTIATED_ROLES_MAX_ENTRIES = 16;
const NEGOTIATED_ROLE_MAX_BYTES = 64;
function negotiatedLeafCaps(provider: LeafRuntimeProvider): Partial<Pick<AgentRpcRecord, 'outputModes' | 'correlationV2' | 'jsonSchema'>> {
  const caps = provider.getNegotiatedCapabilities?.();
  if (caps === undefined) return {};
  const roles = Array.isArray(caps.correlationV2?.roles)
    ? caps.correlationV2.roles
        .filter((role): role is string => typeof role === 'string')
        .map((role) => truncateUtf8Bytes(role, NEGOTIATED_ROLE_MAX_BYTES))
        .slice(0, NEGOTIATED_ROLES_MAX_ENTRIES)
    : [];
  return {
    ...(caps.outputModes.length > 0 ? { outputModes: [...caps.outputModes] } : {}),
    ...(caps.correlationV2 !== undefined
      ? {
          correlationV2: {
            ownerPattern: truncateUtf8Bytes(
              typeof caps.correlationV2.ownerPattern === 'string' ? caps.correlationV2.ownerPattern : '',
              NEGOTIATED_OWNER_PATTERN_MAX_BYTES,
            ),
            roles,
          },
        }
      : {}),
    ...(caps.jsonSchema === 'flat-v1' || caps.jsonSchema === 'structured-v1' ? { jsonSchema: caps.jsonSchema } : {}),
  };
}

/** Run one job to ready/failed. Concurrent callers share one in-flight
 *  drive; the entry clears on settle so later calls observe final status.
 *  A valid deadlineMs persists on the job for later drives; signal applies
 *  to this drive only. */
export async function executeAgentJob(jobId: string, opts?: ExecuteAgentJobOptions): Promise<AgentJobV1> {
  const running = inFlight.get(jobId);
  if (running !== undefined) return running;
  const deadlineMs = validateDeadlineMs(opts?.deadlineMs);
  if (deadlineMs !== undefined) jobDeadlines.set(jobId, deadlineMs);
  const depth = validateDepth(opts?.depth);
  if (depth !== undefined) jobDepths.set(jobId, depth);
  const sink = validateEventSink(opts?.eventSink);
  if (sink !== undefined) jobSinks.set(jobId, sink);
  const drive = driveWithTimeout(jobId, deadlineMs ?? jobDeadlines.get(jobId), opts?.signal).finally(() => {
    if (inFlight.get(jobId) === drive) inFlight.delete(jobId);
  });
  inFlight.set(jobId, drive);
  return drive;
}

/** Drive-signal precedence: an explicit caller signal wins; a configured
 *  deadline adds AbortSignal.timeout; unconfigured drives pass nothing
 *  (legacy default behavior unchanged). Both present composes via any(). */
function buildDriveSignal(deadlineMs: number | undefined, external: AbortSignal | undefined): AbortSignal | undefined {
  const timeout = deadlineMs !== undefined ? AbortSignal.timeout(deadlineMs) : undefined;
  if (external !== undefined && timeout !== undefined && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([external, timeout]);
  }
  return external ?? timeout;
}

/**
 * Bounded drive: a hung drive fails closed at the run deadline instead of
 * holding the in-flight slot forever. The timeout only rejects the race —
 * the slow drive still settles through the normal catch and records failed.
 */
function driveWithTimeout(jobId: string, deadlineMs: number | undefined, signal: AbortSignal | undefined): Promise<AgentJobV1> {
  const bound = deadlineMs ?? AGENT_RUN_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('agent job drive timed out')), bound);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  });
  const run = driveAgentJob(jobId, deadlineMs, signal).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return Promise.race([run, timeout]);
}

/** Single-drive job execution. Never called directly when shared.
 *  deadlineMs/signal forward to the controller only when configured. */
async function driveAgentJob(jobId: string, deadlineMs: number | undefined, signal: AbortSignal | undefined): Promise<AgentJobV1> {
  const job = store.jobs.get(jobId);
  if (job === undefined) throw new Error(`unknown agent job: ${jobId.slice(0, 32)}`);
  if (job.status !== 'running') return job;
  try {
    const runner = await defaultRunner();
    const leaf = await negotiateLeafTransport(job);
    // Wave 5: no preflight — Round 1 owns ALL acquisition. Every
    // network-acquiring call runs inside the controller loop through these
    // wrappers (which only record + delegate: absent sink/journal =
    // byte-identical run). Nothing searches before the core starts, so an
    // early backend outage surfaces as a round-1 gather warning, never as a
    // pre-controller drive failure.
    const searchLog: Array<{ query: string; hitCount: number; failed?: boolean }> = [];
    const fetchLog: Array<{ canonicalUrl: string; byteLength: number; failed?: boolean }> = [];
    // Record-order search slots (mirrors wrappedFetch): each call reserves its
    // slot at CALL time and settles into it, so the journal emitter reads
    // record order under parallel legs (never completion order). Failures
    // settle { hitCount: 0, failed: true } and drain on a later boundary with
    // failed:true instead of gaps.
    const wrappedSearch = async (
      query: string,
    ): Promise<Array<{ title: string; url: string; snippet?: string }>> => {
      const slot = searchLog.length;
      searchLog.push({ query, hitCount: 0, failed: true });
      try {
        const found = await runner.search(query);
        searchLog[slot] = { query, hitCount: Array.isArray(found) ? found.length : 0 };
        return found;
      } catch (error) {
        searchLog[slot] = { query, hitCount: 0, failed: true };
        throw error;
      }
    };
    // Record-order fetch slots: each call reserves its slot at CALL time and
    // settles into it, so the journal emitter reads record order under
    // parallel legs (never completion order). Failures settle
    // { byteLength: 0, failed: true } — no gaps, no later-URL-under-earlier-index.
    const wrappedFetch = async (url: string): Promise<string> => {
      const slot = fetchLog.length;
      fetchLog.push({ canonicalUrl: url, byteLength: 0, failed: true });
      try {
        const body = await runner.fetchText(url);
        const text = typeof body === 'string' ? body : '';
        fetchLog[slot] = { canonicalUrl: url, byteLength: Buffer.byteLength(text, 'utf8') };
        return body;
      } catch (error) {
        fetchLog[slot] = { canonicalUrl: url, byteLength: 0, failed: true };
        throw error;
      }
    };
    // Progress projection: the controller reports stage transitions through
    // this callback; Phase 7 ALSO folds each boundary into the typed journal
    // (deltas + wrapped search/fetch logs supply exact per-leg fields).
    // Counts only — no provider/model identity.
    const driveSignal = buildDriveSignal(deadlineMs, signal);
    // Phase 8 (R5): one frozen capabilities snapshot per job, computed once
    // from process.env (deterministic env-hint inference, no network).
    const capabilitiesSnapshot = snapshotForJob(process.env as Record<string, string | undefined>);
    const coreDeps: AgentCoreDeps = {
      search: wrappedSearch,
      fetchText: wrappedFetch,
      capabilitiesSnapshot,
      // Task 8 code-owned width profile: explicit job depth selects 'deep';
      // absent (or 'balanced') keeps the balanced default with deterministic
      // narrow refinement post-plan in the core.
      gatherProfile: jobDepths.get(jobId) === 'deep' ? 'deep' : 'balanced',
      // Controller deadlineMs is an absolute clock bound; the job-level
      // deadlineMs is a duration — convert at the fake-clock boundary.
      ...(deadlineMs !== undefined ? { deadlineMs: store.now() + deadlineMs } : {}),
      ...(driveSignal !== undefined ? { signal: driveSignal } : {}),
      onProgress: (event: AgentProgressEvent) => {
        mergeProgress(job.jobId, event);
        emitProgressJournal({ jobId: job.jobId, jobQuery: job.query, event, searchLog, fetchLog });
      },
    };
    // Task 7 gather executor: web legs ride the wrapped search/fetch legs
    // (record-order journal logs stay exact); research/github/kg ride
    // callNativeTool; social/video have no native surface yet and degrade to
    // web + warning inside the executor. Snapshot flows per-call via ctx.
    // Not a model dep: the Task 3 kill-switch keeps it (stripAgentModelDeps
    // only removes model-call deps). Lazy import mirrors defaultRunner (no cycle).
    const [{ callNativeTool }] = await Promise.all([import('../../native-tools.js')]);
    const { buildNativeGatherTools, gatherExecutor } = await import('./agent-gather.js');
    const gatherTools = buildNativeGatherTools({
      search: wrappedSearch,
      fetchText: wrappedFetch,
      callNative: (name, args) => callNativeTool(name, args),
    });
    coreDeps.gatherExecutor = (intents, round, ctx) => gatherExecutor(intents, round, { ...ctx, tools: gatherTools });
    // Task 4 steering seams: a negotiated-ready leaf provider drives real
    // planner/evaluator/synthesizer/verifier/repair through leaf RPC
    // (text-JSON mode until structured-v1 negotiates; gating lives in
    // createLeafModelClient). No report leg remains: the only leaf calls are
    // the staged steering seams.
    if (leaf !== undefined) {
      // Shutdown-mid-flight guard: the
      // captured provider ref goes stale when shutdownLeafRuntime clears the
      // seam after negotiation. Steering calls re-check at use time and fail
      // with provider_shutdown (fixed safe reason) instead of driving a dead
      // client; the seams degrade to undefined and the deterministic ladder
      // takes over.
      const guardedLeaf: LeafRuntimeProvider = {
        refreshReady: () => leaf.refreshReady(),
        runLeaf: async (prompt, runOpts) => {
          if (getLeafRuntimeProvider() !== leaf) throw Object.assign(new Error('Leaf runtime shut down; steering unavailable.'), { code: 'provider_shutdown' });
          return leaf.runLeaf(prompt, runOpts);
        },
        ...(leaf.getNegotiatedCapabilities !== undefined
          ? { getNegotiatedCapabilities: () => leaf.getNegotiatedCapabilities?.() }
          : {}),
      };
      const seams = createAgentModelSeams(guardedLeaf, { capabilitiesSnapshot });
      coreDeps.planner = seams.planner;
      coreDeps.evaluator = seams.evaluator;
      coreDeps.synthesizer = seams.synthesizer;
      coreDeps.verifier = seams.verifier;
      coreDeps.repairer = seams.repairer;
      coreDeps.utilityModelClient = seams.utilityModelClient;
    }
    // Task 3 no-model ladder: exact '0' strips model-call deps before the
    // controller runs (Task 4 seams pass through this same point).
    const result: AgentResultV1 = await runAgentCore(
      job.query,
      isAgentSteeringDisabled(process.env as Record<string, string | undefined>) ? stripAgentModelDeps(coreDeps) : coreDeps,
    );
    job.result = result;
    job.status = 'ready';
    // Real synth/verify counts from the deterministic result warnings
    // (unknown omits, never zero-fills), then JobReady closes the journal
    // (failures emit nothing: journal stays incomplete = replayable prefix,
    // never JobReady-terminated).
    emitResultJournalCounts(job.jobId, result);
    emitJournalEvent(job.jobId, {
      type: 'JobReady',
      jobId: job.jobId,
      resultByteLength: Buffer.byteLength(canonicalJson(result), 'utf8'),
      warningCount: Array.isArray(result.warnings) ? result.warnings.length : 0,
    });
    markProgressSettled(job.jobId, 'done');
  } catch (error) {
    markProgressSettled(job.jobId, 'failed');
    job.status = 'failed';
    if (error instanceof AgentDeadlineError) {
      // Deadline carries research-debt warnings: the job still fails, but the
      // debt reaches the user as a degraded result (failed status kept; the
      // snapshot already carries result alongside failed). Warnings clip to
      // the contract byte budget so the degraded result always validates.
      const debt = (Array.isArray(error.warnings) ? error.warnings : [])
        .filter((warning): warning is string => typeof warning === 'string')
        .map((warning) => truncateUtf8Bytes(warning, AGENT_WARNING_MAX_BYTES));
      const degraded: AgentResultV1 = {
        version: 1,
        query: job.query,
        reportText: '',
        claims: [],
        sources: [],
        warnings: [...debt, DEADLINE_MESSAGE],
      };
      if (validateAgentResult(degraded).ok) job.result = degraded;
      job.error = 'agent_job_deadline';
    } else {
      if (job.result === undefined) {
        // Early throw (search leg) with a negotiated leaf transport: no result
        // was ever produced, so the snapshot resets to standalone with a static
        // reason instead of naming a transport that produced nothing.
        job.rpc = {
          attempted: job.rpc.attempted,
          negotiated: job.rpc.negotiated,
          transport: 'standalone',
          reason: 'job failed before any result was produced; transport reset to standalone',
        };
      }
    // Stable generic code only: snapshots are model-visible, so dependency
    // messages never land in job.error. No protected diagnostics surface
    // exists — details stay out entirely rather than inventing one.
    job.error = 'agent_job_failed';
    }
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
  /** Owner-gated progress projection: present only when the controller
   *  reported at least one stage event (absent = pre-Phase-6 byte shape). */
  progress?: AgentJobProgress;
}

/**
 * Byte-stable snapshot: canonical JSON, identical bytes for identical job
 * state. Foreign/missing owner on an owned job resolves exactly like a miss
 * (no existence signal, never another owner's bytes). Carries transport +
 * safe reason only — never provider or model identity.
 *
 * NOTE: on running jobs `rpc.transport` names the NEGOTIATED leg, not a
 * produced result — negotiation records 'leaf-runtime' before the core runs;
 * the negotiated record stands through the deterministic ladder (leaf seam
 * failures degrade with fixed safe reasons, never a transport flip).
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
  const progress = jobProgress.get(jobId);
  const snapshot: AgentJobSnapshot = {
    jobId: job.jobId,
    status: job.status,
    query: job.query,
    updatedAt: job.updatedAt,
    rpc: { transport: job.rpc.transport, reason: job.rpc.reason },
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    // Settled values only, deterministic field order; absent when the core
    // never reported (byte-identical to pre-Phase-6 snapshots).
    ...(progress !== undefined
      ? {
          progress: {
            stage: progress.stage,
            round: progress.round,
            questionsAnswered: progress.questionsAnswered,
            questionsTotal: progress.questionsTotal,
            searchesUsed: progress.searchesUsed,
            fetchesUsed: progress.fetchesUsed,
            // Additive: present only when the core reported usage (absent =
            // pre-Phase-6 byte shape).
            ...(progress.utilityCallsUsed !== undefined ? { utilityCallsUsed: progress.utilityCallsUsed } : {}),
          },
        }
      : {}),
  };
  return canonicalJson(snapshot);
}

/** Freshness probe: a running job older than the visibility TTL without an
 *  update reads stale — still pollable (staleness is distinct from expiry).
 *  Throws unknown/expired exactly like the snapshot path. */
export function isAgentJobSnapshotStale(jobId: string, owner?: string): boolean {
  const job = store.jobs.get(jobId);
  const at = store.now();
  if (job === undefined || expired(job, at)) throw new Error(`unknown or expired agent job: ${jobId.slice(0, 32)}`);
  if (job.owner !== undefined && owner !== job.owner) throw new Error(`unknown or expired agent job: ${jobId.slice(0, 32)}`);
  if (job.status !== 'running') return false;
  return at - job.updatedAt > AGENT_POLL_VISIBILITY_TTL_MS;
}
