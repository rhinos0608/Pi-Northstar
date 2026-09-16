import { createHash } from 'node:crypto';
import { chunkText } from '../../search/chunker.js';
import { truncateUtf8Bytes } from './agent-report-route.js';
import { AGENT_EVIDENCE_EXCERPT_MAX_BYTES, createAgentState, type AgentAcquisitionRoute, type AgentEvidence, type AgentLocator, type AgentSourceClass, type AgentSourceRef } from './agent-state.js';

export interface AgentFetchAcquisition {
  kind: 'fetch'; url: string; canonicalUrl: string; responseId?: string; content: string; title?: string; fetchedAtMs?: number;
}
export interface AgentSearchHitAcquisition { title: string; url: string; snippet?: string; }
export interface AgentSearchAcquisition { kind: 'search'; hits: AgentSearchHitAcquisition[]; }
export type AgentAcquisition = AgentFetchAcquisition | AgentSearchAcquisition;

/** Max fetch content admitted per document (UTF-8 bytes); overlong pages truncate before chunking. */
export const MAX_FETCH_CONTENT_BYTES = 262144;

export interface AgentFetchAdmission { evidence: AgentEvidence[]; truncated: boolean; rejectedCount: number; rejectionReasons: string[]; mergedCount?: number; }

/** Admit fetched chunks only; search hits contain no authoritative document material. */
export function admitFromFetch(state: ReturnType<typeof createAgentState>, fetch: AgentFetchAcquisition, questionIds: string[] = [], round = 0): AgentFetchAdmission {
  // Web path stays byte-compatible: same chunks, same sourceRef shape, same
  // char-range locators as before the provenance redesign.
  return admitChunked(state, {
    canonicalUrl: fetch.canonicalUrl,
    ...(fetch.responseId === undefined ? {} : { responseId: fetch.responseId }),
    sourceClass: sourceClassForUrl(fetch.canonicalUrl),
    acquisitionRoute: 'fetch',
    content: fetch.content,
    questionIds,
    round,
  });
}

interface ChunkedAdmission {
  canonicalUrl: string;
  responseId?: string;
  sourceClass: AgentSourceClass;
  acquisitionRoute: AgentAcquisitionRoute;
  content: string;
  questionIds: string[];
  round: number;
}

/** Shared document-class admission: truncate, hash once, chunk with char-range locators. */
function admitChunked(state: ReturnType<typeof createAgentState>, admission: ChunkedAdmission): AgentFetchAdmission {
  let content = admission.content;
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > MAX_FETCH_CONTENT_BYTES) {
    content = truncateUtf8Bytes(content, MAX_FETCH_CONTENT_BYTES);
    truncated = true;
  }
  // Hoisted: one hash per document, not one per chunk (O(chunks x size) amplifier).
  const documentHash = sha256(content);
  const chunks = chunkText(content);
  const evidence: AgentEvidence[] = [];
  let rejectedCount = 0;
  const reasonSet = new Set<string>();
  let mergedCount = 0;
  for (const chunk of chunks) {
    const result = state.addEvidence({
      sourceRef: { canonicalUrl: admission.canonicalUrl, ...(admission.responseId === undefined ? {} : { responseId: admission.responseId }), sourceClass: admission.sourceClass, acquisitionRoute: admission.acquisitionRoute },
      documentHash, locator: { start: chunk.start, end: chunk.end }, excerpt: chunk.text,
      questionIds: admission.questionIds, round: admission.round, status: 'admitted', contentLength: content.length,
    });
    if ('rejected' in result) {
      rejectedCount += 1;
      reasonSet.add(result.rejected.reason);
    } else if ('mergedQuestions' in result) {
      // Duplicate-content union: linkage already folded into state; not new
      // evidence, not a rejection — counted separately so fixture metrics hold.
      mergedCount += 1;
    } else {
      evidence.push(result);
    }
  }
  return { evidence, truncated, rejectedCount, rejectionReasons: [...reasonSet].slice(0, 3), mergedCount };
}

/** Shared single-excerpt admission: truncate to the excerpt cap, admit one entry. */
function admitSingle(state: ReturnType<typeof createAgentState>, sourceRef: AgentSourceRef, text: string, locator: AgentLocator | { start: 0; end: number }, questionIds: string[], round: number): AgentFetchAdmission {
  let excerpt = text;
  let truncated = false;
  if (Buffer.byteLength(excerpt, 'utf8') > AGENT_EVIDENCE_EXCERPT_MAX_BYTES) {
    excerpt = truncateUtf8Bytes(excerpt, AGENT_EVIDENCE_EXCERPT_MAX_BYTES);
    truncated = true;
  }
  const resolvedLocator: AgentLocator = 'start' in locator ? { start: 0, end: excerpt.length } : locator;
  const result = state.addEvidence({
    sourceRef,
    documentHash: sha256(excerpt),
    locator: resolvedLocator,
    excerpt,
    questionIds,
    round,
    status: 'admitted',
  });
  if ('rejected' in result) return { evidence: [], truncated, rejectedCount: 1, rejectionReasons: [result.rejected.reason], mergedCount: 0 };
  if ('mergedQuestions' in result) return { evidence: [], truncated, rejectedCount: 0, rejectionReasons: [], mergedCount: 1 };
  return { evidence: [result], truncated, rejectedCount: 0, rejectionReasons: [], mergedCount: 0 };
}

/** Candidates never touch the evidence ledger: discovery rows without retrieved content.
 *  Typed D6 union lives in agent-candidates.ts (re-exported here so the executor
 *  seam keeps its import path); this module only builds display-only generic
 *  rows for lanes without a follow-up-compilable shape. */
export type {
  AgentCandidate,
  AgentCandidateKind,
  GenericCandidate,
  GithubCodeCandidate,
  GithubIssueCandidate,
  GithubRepoCandidate,
  KgEntityCandidate,
  ResearchSourceCandidate,
} from './agent-candidates.js';
export interface AgentCandidateRow { title?: string; url?: string; snippet?: string; }
export function collectCandidates(route: AgentAcquisitionRoute, rows: AgentCandidateRow[]): import('./agent-candidates.js').AgentCandidate[] {
  return rows.map((row) => ({
    kind: 'generic' as const,
    route,
    ...(row.title === undefined ? {} : { title: row.title }),
    ...(row.url === undefined ? {} : { url: row.url }),
    ...(row.snippet === undefined ? {} : { snippet: row.snippet }),
  }));
}

export interface AgentResearchAbstractAcquisition {
  /** Returned abstract text: the only research content that grounds claims (abstract-scoped). Metadata rows (title/year) are candidates via collectCandidates, never evidence. */
  abstract: string;
  canonicalUrl?: string;
  provider: string;
  query: string;
}

/** Research abstract → evidence scoped to that abstract (sourceClass 'academic', route 'research'). No external refetch: the abstract arrives in the acquisition payload. */
export function admitResearchAbstract(state: ReturnType<typeof createAgentState>, acq: AgentResearchAbstractAcquisition, questionIds: string[] = [], round = 0): AgentFetchAdmission {
  const sourceRef: AgentSourceRef = acq.canonicalUrl === undefined
    ? { canonicalUrl: '', identity: { provider: acq.provider, query: acq.query }, sourceClass: 'academic', acquisitionRoute: 'research' }
    : { canonicalUrl: acq.canonicalUrl, sourceClass: 'academic', acquisitionRoute: 'research' };
  return admitSingle(state, sourceRef, acq.abstract, { start: 0, end: 0 }, questionIds, round);
}

export interface AgentGithubContentAcquisition {
  /** Retrieved file/issue/commit content (already fetched, never refetched here). */
  content: string;
  canonicalUrl: string;
  /** Issue/commit ref (e.g. owner/repo#123, commit sha): recorded as responseId. */
  ref?: string;
}

/** Retrieved GitHub file/issue/commit content → evidence (sourceClass 'repo', route 'github', char-range chunks). */
export function admitGithubContent(state: ReturnType<typeof createAgentState>, acq: AgentGithubContentAcquisition, questionIds: string[] = [], round = 0): AgentFetchAdmission {
  return admitChunked(state, {
    canonicalUrl: acq.canonicalUrl,
    ...(acq.ref === undefined ? {} : { responseId: acq.ref }),
    sourceClass: 'repo',
    acquisitionRoute: 'github',
    content: acq.content,
    questionIds,
    round,
  });
}

export interface AgentSocialBodyAcquisition {
  /** Retrieved post/thread/comment body (already fetched, never refetched here). */
  body: string;
  canonicalUrl: string;
}

/** Retrieved social post/thread/comment body → evidence (sourceClass 'community', route 'social'). */
export function admitSocialBody(state: ReturnType<typeof createAgentState>, acq: AgentSocialBodyAcquisition, questionIds: string[] = [], round = 0): AgentFetchAdmission {
  return admitSingle(state, { canonicalUrl: acq.canonicalUrl, sourceClass: 'community', acquisitionRoute: 'social' }, acq.body, { start: 0, end: 0 }, questionIds, round);
}

export interface AgentVideoSegmentAcquisition {
  /** Transcript segment text (already retrieved, never refetched here). */
  segment: string;
  /** Segment offset in seconds from media start. */
  timestamp: number;
  canonicalUrl: string;
}

/** Video transcript segment → evidence (route 'video', {timestamp} locator, sourceClass from the shared domain rules: gov/edu/repo hosts map as usual, video hosts fall to 'unknown'). */
export function admitVideoTranscriptSegment(state: ReturnType<typeof createAgentState>, acq: AgentVideoSegmentAcquisition, questionIds: string[] = [], round = 0): AgentFetchAdmission {
  return admitSingle(state, { canonicalUrl: acq.canonicalUrl, sourceClass: sourceClassForUrl(acq.canonicalUrl), acquisitionRoute: 'video' }, acq.segment, { timestamp: acq.timestamp }, questionIds, round);
}

export interface AgentKgFieldAcquisition { nodeId: string; field: string; value: string; }
export interface AgentKgAcquisition {
  provider: string;
  query: string;
  /** Explicit returned fields only: each field admits one entry. No field → no evidence. */
  fields: AgentKgFieldAcquisition[];
}

/** KG rows → evidence for explicit returned fields only ({nodeId, field} locator + structured identity, route 'kg'). Node/field values trim at admission: checkLocator validates trimmed but stores raw, so admission normalizes first (whitespace-padded duplicates collapse downstream). */
export function admitKgFields(state: ReturnType<typeof createAgentState>, acq: AgentKgAcquisition, questionIds: string[] = [], round = 0): AgentFetchAdmission {
  const evidence: AgentEvidence[] = [];
  let truncated = false;
  let rejectedCount = 0;
  const reasonSet = new Set<string>();
  let mergedCount = 0;
  for (const field of acq.fields) {
    const nodeId = typeof field.nodeId === 'string' ? field.nodeId.trim() : field.nodeId;
    const name = typeof field.field === 'string' ? field.field.trim() : field.field;
    const admitted = admitSingle(state, { canonicalUrl: '', identity: { provider: acq.provider, query: acq.query, nodeId }, sourceClass: 'unknown', acquisitionRoute: 'kg' }, field.value, { nodeId, field: name }, questionIds, round);
    evidence.push(...admitted.evidence);
    truncated = truncated || admitted.truncated;
    rejectedCount += admitted.rejectedCount;
    for (const reason of admitted.rejectionReasons) { if (reasonSet.size < 3) reasonSet.add(reason); }
    mergedCount += admitted.mergedCount ?? 0;
  }
  return { evidence, truncated, rejectedCount, rejectionReasons: [...reasonSet], mergedCount };
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sourceClassForUrl(url: string): AgentSourceClass {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.gov') || host.endsWith('.edu')) return host.endsWith('.edu') ? 'academic' : 'official';
    if (host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')) return 'repo';
    return 'unknown';
  } catch { return 'unknown'; }
}
