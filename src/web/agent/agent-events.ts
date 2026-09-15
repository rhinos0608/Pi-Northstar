// Typed event journal (Phase 7): durable execution seam.
// Events carry counts/ids/hashes ONLY — never content text, never
// provider/model identity, never secrets. Exception: the JobCreated and
// SearchCompleted query fields contain user-provided query text. Live state
// stays authoritative; projection replays the journal without repaying
// completed work.
import { canonicalJson } from './agent-contract.js';

/** Journal byte ceiling (UTF-8): append past this rejects, never truncates. */
export const MAX_JOURNAL_BYTES = 256 * 1024;
/** Sanitized query ceiling per SearchCompleted event (UTF-8 bytes). */
export const AGENT_EVENT_QUERY_MAX_BYTES = 512;
/** Normalized canonical URL ceiling per FetchCompleted event (UTF-8 bytes). */
export const AGENT_EVENT_URL_MAX_BYTES = 2048;

const JOB_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const EVIDENCE_ID_PATTERN = /^ev-[0-9a-f]+$/;
// Question ids: stable `q-<hex>` (agent-state.ts questionId) or `rf-<hex>`
// forward alias. Both are opaque stable ids, never content.
const QUESTION_ID_PATTERN = /^(?:q|rf)-[0-9a-f]+$/;
const HEX_PATTERN = /^[0-9a-f]{8,128}$/;
const STOP_REASON_MAX_BYTES = 512;

export interface JobCreatedEvent { type: 'JobCreated'; jobId: string; query: string; createdAtMs: number; }
export interface PlanAcceptedEvent { type: 'PlanAccepted'; jobId: string; questionsTotal: number; questionIds: string[]; scopeNoteCount: number; }
export interface SearchCompletedEvent { type: 'SearchCompleted'; jobId: string; round: number; query: string; hitCount: number; searchesUsed: number; failed?: boolean; }
export interface FetchCompletedEvent { type: 'FetchCompleted'; jobId: string; round: number; canonicalUrl: string; byteLength: number; fetchesUsed: number; failed?: boolean; }
export interface EvidenceAdmittedEvent { type: 'EvidenceAdmitted'; jobId: string; evidenceId: string; round: number; questionIds: string[]; excerptHash: string; fingerprint: string; }
export interface EvaluationAcceptedEvent { type: 'EvaluationAccepted'; jobId: string; round: number; answeredCount: number; nextQueryCount: number; droppedNextQueries: number; }
export interface RoundClosedEvent { type: 'RoundClosed'; jobId: string; round: number; growthCount: number; conflictsCount: number; stopReason?: string; }
export interface SynthesisCompletedEvent { type: 'SynthesisCompleted'; jobId: string; claimUnitCount: number; blockCount: number; orphanedCount: number; }
export interface VerificationCompletedEvent { type: 'VerificationCompleted'; jobId: string; supportedCount: number; refutedCount: number; unsupportedCount: number; repairApplied: number; repairRejected: number; }
export interface JobReadyEvent { type: 'JobReady'; jobId: string; resultByteLength: number; warningCount: number; }

// EvidenceAdmitted emits live from the core→jobs detail seam (todo #14):
// the core reports admitted batches on gather progress, the jobs shell maps
// each entry to one event. Projection handles it when present.
export type AgentResearchEvent =
  | JobCreatedEvent
  | PlanAcceptedEvent
  | SearchCompletedEvent
  | FetchCompletedEvent
  | EvidenceAdmittedEvent
  | EvaluationAcceptedEvent
  | RoundClosedEvent
  | SynthesisCompletedEvent
  | VerificationCompletedEvent
  | JobReadyEvent;

export type AgentEventType = AgentResearchEvent['type'];

const EVENT_TYPES: readonly string[] = [
  'JobCreated',
  'PlanAccepted',
  'SearchCompleted',
  'FetchCompleted',
  'EvidenceAdmitted',
  'EvaluationAccepted',
  'RoundClosed',
  'SynthesisCompleted',
  'VerificationCompleted',
  'JobReady',
];

// Exact keys per event type (RoundClosed allows optional stopReason).
const EVENT_KEYS: Record<AgentEventType, readonly string[]> = {
  JobCreated: ['type', 'jobId', 'query', 'createdAtMs'],
  PlanAccepted: ['type', 'jobId', 'questionsTotal', 'questionIds', 'scopeNoteCount'],
  SearchCompleted: ['type', 'jobId', 'round', 'query', 'hitCount', 'searchesUsed', 'failed'],
  FetchCompleted: ['type', 'jobId', 'round', 'canonicalUrl', 'byteLength', 'fetchesUsed', 'failed'],
  EvidenceAdmitted: ['type', 'jobId', 'evidenceId', 'round', 'questionIds', 'excerptHash', 'fingerprint'],
  EvaluationAccepted: ['type', 'jobId', 'round', 'answeredCount', 'nextQueryCount', 'droppedNextQueries'],
  RoundClosed: ['type', 'jobId', 'round', 'growthCount', 'conflictsCount', 'stopReason'],
  SynthesisCompleted: ['type', 'jobId', 'claimUnitCount', 'blockCount', 'orphanedCount'],
  VerificationCompleted: ['type', 'jobId', 'supportedCount', 'refutedCount', 'unsupportedCount', 'repairApplied', 'repairRejected'],
  JobReady: ['type', 'jobId', 'resultByteLength', 'warningCount'],
};

const OPTIONAL_KEYS: Record<string, readonly string[]> = {
  RoundClosed: ['stopReason'],
  FetchCompleted: ['failed'],
  SearchCompleted: ['failed'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');
const isQuestionId = (value: unknown): value is string =>
  typeof value === 'string' && QUESTION_ID_PATTERN.test(value);

/** Validate a single event: exact-keys + field types + caps + id formats. Reject, never coerce. */
export function validateAgentResearchEvent(value: unknown): { ok: true; event: AgentResearchEvent } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'event is not an object' };
  const type = value['type'];
  if (typeof type !== 'string' || !EVENT_TYPES.includes(type)) return { ok: false, reason: 'unknown event type' };
  const expected = EVENT_KEYS[type as AgentEventType];
  const optional = OPTIONAL_KEYS[type] ?? [];
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!expected.includes(key)) return { ok: false, reason: `unexpected field "${key}"` };
  }
  for (const key of expected) {
    if (optional.includes(key)) continue;
    if (!(key in value)) return { ok: false, reason: `missing field "${key}"` };
  }
  const jobId = value['jobId'];
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) return { ok: false, reason: 'invalid jobId' };

  const needCount = (field: string): string | null => {
    if (!isNonNegativeInt(value[field])) return `invalid ${field}`;
    return null;
  };
  const needQuery = (field: string): string | null => {
    const entry = value[field];
    if (typeof entry !== 'string' || entry.trim() === '') return `invalid ${field}`;
    if (byteLength(entry) > AGENT_EVENT_QUERY_MAX_BYTES) return `${field} exceeds maximum bytes`;
    return null;
  };

  switch (type as AgentEventType) {
    case 'JobCreated': {
      const bad = needQuery('query');
      if (bad) return { ok: false, reason: bad };
      if (!isNonNegativeInt(value['createdAtMs'])) return { ok: false, reason: 'invalid createdAtMs' };
      break;
    }
    case 'PlanAccepted': {
      for (const field of ['questionsTotal', 'scopeNoteCount'] as const) {
        const bad = needCount(field);
        if (bad) return { ok: false, reason: bad };
      }
      const ids = value['questionIds'];
      if (!Array.isArray(ids) || !ids.every(isQuestionId)) return { ok: false, reason: 'invalid questionIds' };
      if (ids.length !== (value['questionsTotal'] as number)) return { ok: false, reason: 'questionsTotal does not match questionIds length' };
      break;
    }
    case 'SearchCompleted': {
      const bad = needQuery('query');
      if (bad) return { ok: false, reason: bad };
      for (const field of ['round', 'hitCount', 'searchesUsed'] as const) {
        const miss = needCount(field);
        if (miss) return { ok: false, reason: miss };
      }
      const searchFailed = value['failed'];
      if (searchFailed !== undefined && typeof searchFailed !== 'boolean') return { ok: false, reason: 'invalid failed' };
      break;
    }
    case 'FetchCompleted': {
      for (const field of ['round', 'byteLength', 'fetchesUsed'] as const) {
        const miss = needCount(field);
        if (miss) return { ok: false, reason: miss };
      }
      const url = value['canonicalUrl'];
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, reason: 'invalid canonicalUrl' };
      if (byteLength(url) > AGENT_EVENT_URL_MAX_BYTES) return { ok: false, reason: 'canonicalUrl exceeds maximum bytes' };
      const failed = value['failed'];
      if (failed !== undefined && typeof failed !== 'boolean') return { ok: false, reason: 'invalid failed' };
      break;
    }
    case 'EvidenceAdmitted': {
      if (typeof value['evidenceId'] !== 'string' || !EVIDENCE_ID_PATTERN.test(value['evidenceId'] as string)) {
        return { ok: false, reason: 'invalid evidenceId' };
      }
      const miss = needCount('round');
      if (miss) return { ok: false, reason: miss };
      const ids = value['questionIds'];
      if (!Array.isArray(ids) || !ids.every(isQuestionId)) return { ok: false, reason: 'invalid questionIds' };
      for (const field of ['excerptHash', 'fingerprint'] as const) {
        const entry = value[field];
        if (typeof entry !== 'string' || !HEX_PATTERN.test(entry)) return { ok: false, reason: `invalid ${field}` };
      }
      break;
    }
    case 'EvaluationAccepted': {
      for (const field of ['round', 'answeredCount', 'nextQueryCount', 'droppedNextQueries'] as const) {
        const miss = needCount(field);
        if (miss) return { ok: false, reason: miss };
      }
      break;
    }
    case 'RoundClosed': {
      for (const field of ['round', 'growthCount', 'conflictsCount'] as const) {
        const miss = needCount(field);
        if (miss) return { ok: false, reason: miss };
      }
      const stop = value['stopReason'];
      if (stop !== undefined) {
        if (typeof stop !== 'string' || stop.trim() === '' || byteLength(stop) > STOP_REASON_MAX_BYTES) {
          return { ok: false, reason: 'invalid stopReason' };
        }
      }
      break;
    }
    case 'SynthesisCompleted': {
      for (const field of ['claimUnitCount', 'blockCount', 'orphanedCount'] as const) {
        const miss = needCount(field);
        if (miss) return { ok: false, reason: miss };
      }
      break;
    }
    case 'VerificationCompleted': {
      for (const field of ['supportedCount', 'refutedCount', 'unsupportedCount', 'repairApplied', 'repairRejected'] as const) {
        const miss = needCount(field);
        if (miss) return { ok: false, reason: miss };
      }
      break;
    }
    case 'JobReady': {
      for (const field of ['resultByteLength', 'warningCount'] as const) {
        const miss = needCount(field);
        if (miss) return { ok: false, reason: miss };
      }
      break;
    }
  }
  return { ok: true, event: value as unknown as AgentResearchEvent };
}

export interface AgentEventJournal {
  jobId: string;
  events: AgentResearchEvent[];
  append(event: unknown): { ok: true } | { ok: false; reason: string };
}

/** Canonical bytes for a journal (byte-stable: canonicalJson key order). */
export function serializeJournal(journal: Pick<AgentEventJournal, 'jobId' | 'events'>): string {
  return canonicalJson({ jobId: journal.jobId, events: journal.events });
}

export function createAgentEventJournal(jobId: string): AgentEventJournal | { rejected: { reason: string } } {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) return { rejected: { reason: 'invalid jobId' } };
  const journal: AgentEventJournal = {
    jobId,
    events: [],
    append(event: unknown): { ok: true } | { ok: false; reason: string } {
      const checked = validateAgentResearchEvent(event);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      if (checked.event.jobId !== jobId) return { ok: false, reason: 'event jobId mismatch' };
      const next = canonicalJson({ jobId, events: [...journal.events, checked.event] });
      if (Buffer.byteLength(next, 'utf8') > MAX_JOURNAL_BYTES) {
        return { ok: false, reason: 'journal byte limit reached' };
      }
      journal.events.push(checked.event);
      return { ok: true };
    },
  };
  return journal;
}

export interface ProjectedAgentState {
  rounds: number;
  searchesUsed: number;
  fetchesUsed: number;
  evidenceIds: string[];
  questionIds: string[];
  counts: { answered: number; grounded: number };
}

/**
 * Pure fold over journal events. Fail-closed: any unknown/invalid event
 * rejects the whole projection — never partial state.
 */
export function projectAgentState(
  journal: Pick<AgentEventJournal, 'jobId' | 'events'>,
  _baseGoal: string,
): { ok: true; state: ProjectedAgentState } | { ok: false; reason: string } {
  let rounds = 0;
  let searchesUsed = 0;
  let fetchesUsed = 0;
  let answered = 0;
  let grounded = 0;
  const evidenceIds: string[] = [];
  const seenEvidence = new Set<string>();
  const questionIds: string[] = [];
  const seenQuestions = new Set<string>();
  const pushId = (id: string): void => {
    if (!seenQuestions.has(id)) {
      seenQuestions.add(id);
      questionIds.push(id);
    }
  };

  for (const raw of journal.events) {
    const checked = validateAgentResearchEvent(raw);
    if (!checked.ok) return { ok: false, reason: 'unknown event type' };
    const event = checked.event;
    switch (event.type) {
      case 'JobCreated': break;
      case 'PlanAccepted':
        for (const id of event.questionIds) pushId(id);
        break;
      case 'SearchCompleted':
        rounds = Math.max(rounds, event.round);
        searchesUsed = Math.max(searchesUsed, event.searchesUsed);
        break;
      case 'FetchCompleted':
        rounds = Math.max(rounds, event.round);
        fetchesUsed = Math.max(fetchesUsed, event.fetchesUsed);
        break;
      case 'EvidenceAdmitted':
        rounds = Math.max(rounds, event.round);
        if (!seenEvidence.has(event.evidenceId)) {
          seenEvidence.add(event.evidenceId);
          evidenceIds.push(event.evidenceId);
        }
        for (const id of event.questionIds) pushId(id);
        break;
      case 'EvaluationAccepted':
        rounds = Math.max(rounds, event.round);
        answered = event.answeredCount;
        break;
      case 'RoundClosed':
        rounds = Math.max(rounds, event.round);
        break;
      case 'SynthesisCompleted': break;
      case 'VerificationCompleted':
        grounded = event.supportedCount;
        break;
      case 'JobReady': break;
    }
  }
  return { ok: true, state: { rounds, searchesUsed, fetchesUsed, evidenceIds, questionIds, counts: { answered, grounded } } };
}

const roundOf = (event: AgentResearchEvent): number | null => {
  switch (event.type) {
    case 'SearchCompleted':
    case 'FetchCompleted':
    case 'EvidenceAdmitted':
    case 'EvaluationAccepted':
    case 'RoundClosed':
      return event.round;
    default:
      return null;
  }
};

/**
 * Structural replay check: valid ids/events, JobCreated first, JobReady only
 * last, monotonic rounds and counters. Incomplete (no JobReady) passes when
 * the prefix is structurally sound.
 */
export function replayable(jobId: string, journal: Pick<AgentEventJournal, 'jobId' | 'events'>): boolean {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) return false;
  if (journal.jobId !== jobId) return false;
  if (journal.events.length === 0) return false;
  let lastRound = 0;
  let lastSearches = 0;
  let lastFetches = 0;
  for (const [index, raw] of journal.events.entries()) {
    const checked = validateAgentResearchEvent(raw);
    if (!checked.ok) return false;
    const event = checked.event;
    if (event.jobId !== jobId) return false;
    if (index === 0 && event.type !== 'JobCreated') return false;
    if (event.type === 'JobReady' && index !== journal.events.length - 1) return false;
    if (event.type === 'JobCreated' && index !== 0) return false;
    const round = roundOf(event);
    if (round !== null) {
      if (round < lastRound) return false;
      lastRound = round;
    }
    if (event.type === 'SearchCompleted') {
      if (event.searchesUsed < lastSearches) return false;
      lastSearches = event.searchesUsed;
    }
    if (event.type === 'FetchCompleted') {
      if (event.fetchesUsed < lastFetches) return false;
      lastFetches = event.fetchesUsed;
    }
  }
  return true;
}
