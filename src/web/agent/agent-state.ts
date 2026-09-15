import { createHash } from 'node:crypto';
import { canonicalJson } from './agent-contract.js';
import { normalizeUrl } from '../../search/fusion.js';

export type AgentSourceClass = 'official' | 'docs' | 'repo' | 'academic' | 'news' | 'community' | 'unknown';
export type AgentEvidenceStatus = 'admitted' | 'rejected' | 'superseded';
export type AgentAcquisitionRoute = 'search' | 'fetch' | 'report-suggested-fetch';

export interface AgentEvidence {
  id: string;
  sourceRef: { canonicalUrl: string; responseId?: string; sourceClass: AgentSourceClass; acquisitionRoute: AgentAcquisitionRoute };
  documentHash: string;
  locator: { start: number; end: number };
  excerpt: string;
  excerptHash: string;
  questionIds: string[];
  round: number;
  status: AgentEvidenceStatus;
  corroboratingFingerprint: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizedTokens = (text: string) => (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []);
const tokenBigrams = (text: string) => {
  const tokens = normalizedTokens(text);
  // Fall back to unigrams when fewer than two tokens: otherwise every
  // short text yields the same empty bigram set (same fingerprint and a
  // jaccard of 1), so unrelated single-word texts compare as identical.
  if (tokens.length === 1) return new Set(tokens);
  // Punctuation-only text has no tokens at all: key on the normalized
  // excerpt (whitespace-collapsed) so distinct such texts get distinct
  // fingerprints. The key contains punctuation, so it can never collide
  // with the letter/digit tokens other texts produce.
  if (tokens.length === 0) return new Set([text.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim()]);
  const result = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) result.add(`${tokens[i]} ${tokens[i + 1]}`);
  return result;
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
};

export function corroboratingFingerprint(excerpt: string): string {
  return sha256([...tokenBigrams(excerpt)].sort().join('\n')).slice(0, 16);
}
export function isNearDuplicate(a: AgentEvidence, b: AgentEvidence): boolean {
  return a.corroboratingFingerprint === b.corroboratingFingerprint && jaccard(tokenBigrams(a.excerpt), tokenBigrams(b.excerpt)) >= 0.8;
}
export function independentSourcesFor(evidence: AgentEvidence[]): number {
  return new Set(evidence.filter((e) => e.status === 'admitted').map((e) => e.corroboratingFingerprint)).size;
}

export interface AgentQuestion { id: string; question: string; priority: number; required: boolean; status: 'open' | 'answered' | 'grounded' | 'blocked' | 'abandoned'; groundedBy?: string[]; }
export function questionId(question: string): string { return `q-${sha256(question.trim().toLowerCase()).slice(0, 12)}`; }

/** Max admitted evidence entries per state (reject-not-drop past the cap). */
export const MAX_EVIDENCE = 256;
/** Max excerpt bytes per evidence entry (UTF-8). */
export const AGENT_EVIDENCE_EXCERPT_MAX_BYTES = 4096;
/** Max recorded queries per state (reject-not-drop past the cap). */
export const MAX_QUERIES = 128;
/** Max query bytes per recorded query (UTF-8). */
export const MAX_QUERY_BYTES = 2048;
/** Max questions per state (reject-not-drop past the cap). */
export const MAX_QUESTIONS = 64;
/** Max goal bytes (UTF-8); createAgentState throws past the cap. */
export const MAX_GOAL_BYTES = 2048;
/** Max question bytes per added question (UTF-8). */
export const MAX_QUESTION_BYTES = 2048;

const QUESTION_ID_RE = /^(?:q|rf)-[0-9a-f]+$/;

/** Filter raw questionIds to valid format, deduped, capped at MAX_QUESTIONS;
 *  overflow past the cap and invalid-format ids silently ignored (never merged). */
export function sanitizeQuestionIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !QUESTION_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    if (out.length >= MAX_QUESTIONS) break;
    out.push(id);
  }
  return out;
}

export interface AgentQuery { query: string; questionId?: string; route: string; identityKey: string; }
export interface AgentStateSnapshot { goal: string; counters: { searchesUsed: number; fetchesUsed: number; rounds: number }; admittedEvidence: AgentEvidence[]; questions: AgentQuestion[]; queries: AgentQuery[]; }
export type AgentEvidenceInput = Omit<AgentEvidence, 'id' | 'sourceRef' | 'excerptHash' | 'corroboratingFingerprint'> & { sourceRef: AgentEvidence['sourceRef']; contentLength?: number };
export interface AgentState extends AgentStateSnapshot {
  addEvidence(input: AgentEvidenceInput): (AgentEvidence & { mergedQuestions?: string[] }) | { rejected: { reason: string } };
  addQuestion(input: { question: string; priority?: number; required?: boolean }): AgentQuestion | { rejected: { reason: string } };
  promoteToGrounded(questionId: string, evidenceIds: string[]): boolean | { rejected: { reason: string } };
  recordQuery(input: { query: string; questionId?: string; route: string }): AgentQuery | { rejected: { reason: string } };
  hasExactDuplicate(input: { query: string; questionId?: string; route: string }): boolean;
  isSimilar(query: string): AgentQuery[];
  snapshot(): string;
}

export function createAgentState({ goal }: { goal: string }): AgentState {
  if (typeof goal !== 'string' || Buffer.byteLength(goal, 'utf8') > MAX_GOAL_BYTES) {
    throw new RangeError('goal exceeds maximum bytes');
  }
  const state: AgentStateSnapshot = { goal, counters: { searchesUsed: 0, fetchesUsed: 0, rounds: 0 }, admittedEvidence: [], questions: [], queries: [] };
  const identity = (query: string, route: string, q?: string) => `${query.trim().toLowerCase()}\u0000${route.trim().toLowerCase()}\u0000${q ?? 'root'}`;
  const methods = {
    addEvidence(input: AgentEvidenceInput): (AgentEvidence & { mergedQuestions?: string[] }) | { rejected: { reason: string } } {
      const url = normalizeUrl(input.sourceRef.canonicalUrl);
      // Content validation first (cap excluded: existing-id dedup-merge proceeds even at cap).
      const reason = !input.excerpt || input.excerpt.trim() === '' ? 'excerpt is empty' : Buffer.byteLength(input.excerpt, 'utf8') > AGENT_EVIDENCE_EXCERPT_MAX_BYTES ? 'excerpt exceeds maximum bytes' : !input.documentHash || input.documentHash.trim() === '' ? 'documentHash is required' : !/^https?:\/\//i.test(url) ? 'canonicalUrl must be an http(s) URL' : !Number.isInteger(input.locator.start) || !Number.isInteger(input.locator.end) || input.locator.start < 0 || input.locator.end <= input.locator.start || (input.contentLength !== undefined && input.locator.end > input.contentLength) ? 'invalid locator' : (input.locator.end - input.locator.start) !== input.excerpt.length ? 'locator does not match excerpt length' : !['admitted', 'rejected', 'superseded'].includes(input.status) ? 'unknown status' : '';
      if (reason) return { rejected: { reason } };
      // admittedEvidence holds admitted entries only: rejected/superseded
      // inputs validate (unknown statuses still reject above) but never
      // touch state — no dedup-merge, no cap consumption, no push.
      if (input.status !== 'admitted') return { rejected: { reason: 'evidence status is not admitted' } };
      // Caller-supplied id/hash/fingerprint never trusted: always recomputed
      // from content (stable id = sha256(normalizedUrl + excerptHash)).
      const excerptHash = sha256(input.excerpt);
      const id = `ev-${sha256(url + excerptHash)}`;
      const existing = state.admittedEvidence.find((e) => e.id === id);
      if (existing) {
        // Linkage-loss close: same content refetched for a new question unions
        // the new questionIds into the first-seen entry (dedupe; excerpt and
        // locator stay first-seen). Identical questionIds → plain existing.
        // Invalid-format ids never merged; union capped at MAX_QUESTIONS
        // (overflow silently ignored); result sorted ascending lexical so
        // snapshot bytes stay deterministic regardless of arrival order.
        const fresh = sanitizeQuestionIds(input.questionIds).filter((q) => !existing.questionIds.includes(q));
        if (fresh.length === 0) return existing;
        const room = Math.max(0, MAX_QUESTIONS - existing.questionIds.length);
        const kept = fresh.sort().slice(0, room);
        if (kept.length === 0) return existing;
        existing.questionIds.push(...kept);
        existing.questionIds.sort();
        // Ephemeral marker ships on a COPY only: the stored entry never gains
        // the mergedQuestions key, so snapshots stay free of ephemeral keys.
        return { ...existing, mergedQuestions: kept };
      }
      if (state.admittedEvidence.length >= MAX_EVIDENCE) return { rejected: { reason: 'evidence limit reached' } };
      // Allowlist construction: unknown top-level/input keys never leak into state.
      const evidence: AgentEvidence = { id, sourceRef: { canonicalUrl: url, ...(input.sourceRef.responseId === undefined ? {} : { responseId: input.sourceRef.responseId }), sourceClass: input.sourceRef.sourceClass, acquisitionRoute: input.sourceRef.acquisitionRoute }, documentHash: input.documentHash, locator: { start: input.locator.start, end: input.locator.end }, excerpt: input.excerpt, excerptHash, questionIds: sanitizeQuestionIds(input.questionIds), round: input.round, status: input.status, corroboratingFingerprint: corroboratingFingerprint(input.excerpt) };
      state.admittedEvidence.push(evidence);
      return evidence;
    },
    promoteToGrounded(questionId: string, evidenceIds: string[]) {
      const question = state.questions.find((q) => q.id === questionId);
      if (!question) return { rejected: { reason: 'unknown question id' } };
      if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return { rejected: { reason: 'evidenceIds must be non-empty' } };
      for (const id of evidenceIds) { const e = state.admittedEvidence.find((item) => item.id === id); if (!e || e.status !== 'admitted' || e.locator.end <= e.locator.start) return { rejected: { reason: 'evidence id is not admitted' } }; }
      question.status = 'grounded';
      question.groundedBy = [...evidenceIds];
      return true;
    },
    addQuestion(input: { question: string; priority?: number; required?: boolean }) {
      if (typeof input.question !== 'string' || input.question.trim() === '') return { rejected: { reason: 'question is required' } };
      if (Buffer.byteLength(input.question, 'utf8') > MAX_QUESTION_BYTES) return { rejected: { reason: 'question exceeds maximum bytes' } };
      if (state.questions.length >= MAX_QUESTIONS) return { rejected: { reason: 'question limit reached' } };
      const id = questionId(input.question);
      if (state.questions.some((q) => q.id === id)) return { rejected: { reason: 'duplicate question' } };
      const entry: AgentQuestion = { id, question: input.question, priority: typeof input.priority === 'number' ? input.priority : 1, required: typeof input.required === 'boolean' ? input.required : true, status: 'open' };
      state.questions.push(entry);
      return entry;
    },
    recordQuery(input: { query: string; questionId?: string; route: string }) {
      if (typeof input.query !== 'string' || typeof input.route !== 'string' || !input.query.trim() || !input.route.trim()) return { rejected: { reason: 'query and route are required' } };
      if (Buffer.byteLength(input.query, 'utf8') > MAX_QUERY_BYTES) return { rejected: { reason: 'query exceeds maximum bytes' } };
      if (state.queries.length >= MAX_QUERIES) return { rejected: { reason: 'query limit reached' } };
      const entry: AgentQuery = { query: input.query, ...(input.questionId === undefined ? {} : { questionId: input.questionId }), route: input.route, identityKey: identity(input.query, input.route, input.questionId) };
      if (state.queries.some((q) => q.identityKey === entry.identityKey)) return { rejected: { reason: 'exact duplicate query' } };
      state.queries.push(entry); return entry;
    },
    hasExactDuplicate(input: { query: string; questionId?: string; route: string }): boolean { return state.queries.some((q) => q.identityKey === identity(input.query, input.route, input.questionId)); },
    isSimilar(query: string): AgentQuery[] { return state.queries.filter((q) => jaccard(tokenBigrams(q.query), tokenBigrams(query)) >= 0.85); },
    snapshot(): string { return canonicalJson({ goal: state.goal, counters: state.counters, admittedEvidence: state.admittedEvidence, questions: state.questions, queries: state.queries }); },
  };
  return Object.assign(state, methods) as AgentState;
}
