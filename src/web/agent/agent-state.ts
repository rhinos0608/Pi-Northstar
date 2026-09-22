import { createHash } from 'node:crypto';
import { canonicalJson } from './agent-contract.js';
import { normalizeUrl } from '../../search/fusion.js';

export type AgentSourceClass = 'official' | 'docs' | 'repo' | 'academic' | 'news' | 'community' | 'unknown';
export type AgentEvidenceStatus = 'admitted' | 'rejected' | 'superseded';
export type AgentAcquisitionRoute = 'search' | 'fetch' | 'report-suggested-fetch' | 'research' | 'github' | 'social' | 'video' | 'kg';

/** Known acquisition routes (reject-never-drop: unknown route strings reject at admission). Graph stays absent in v1. */
export const AGENT_ACQUISITION_ROUTES: readonly AgentAcquisitionRoute[] = ['search', 'fetch', 'report-suggested-fetch', 'research', 'github', 'social', 'video', 'kg'];

/** Char-range locator for document-class evidence (fetch chunks, files, abstracts, post bodies). */
export interface AgentCharRangeLocator { start: number; end: number; }
/** Page locator for paged artifacts (PDFs, paged reports). Page numbers are 0-based. */
export interface AgentPageLocator { page: number; }
/** Line locator for line-addressable content. Line numbers are 0-based. */
export interface AgentLineLocator { line: number; }
/** Timestamp locator (seconds from media start) for transcript segments. */
export interface AgentTimestampLocator { timestamp: number; }
/** Opaque revision locator for issue/commit refs. */
export interface AgentRefLocator { ref: string; }
/** KG field locator: the explicit returned field of an explicit node. Both required. */
export interface AgentKgLocator { nodeId: string; field: string; }
export type AgentLocator = AgentCharRangeLocator | AgentPageLocator | AgentLineLocator | AgentTimestampLocator | AgentRefLocator | AgentKgLocator;

/** Structured non-URL source identity for KG rows and other URL-less artifacts. */
export interface AgentStructuredIdentity { provider: string; query: string; nodeId?: string; }
export interface AgentSourceRef {
  /** Normalized http(s) URL when the source has one; '' exactly when identity carries the source instead (url XOR identity). Kept required-typed so downstream URL readers stay total. */
  canonicalUrl: string;
  identity?: AgentStructuredIdentity;
  responseId?: string;
  sourceClass: AgentSourceClass;
  acquisitionRoute: AgentAcquisitionRoute;
}

export interface AgentEvidence {
  id: string;
  sourceRef: AgentSourceRef;
  documentHash: string;
  locator: AgentLocator;
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
  return sha256([...tokenBigrams(excerpt)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n')).slice(0, 16);
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
/** Max provider bytes for structured source identity (UTF-8). */
export const AGENT_IDENTITY_PROVIDER_MAX_BYTES = 64;
/** Max node-id bytes for structured source identity and KG locators (UTF-8). */
export const AGENT_IDENTITY_NODE_ID_MAX_BYTES = 256;
/** Max ref bytes for issue/commit locators (UTF-8). */
export const AGENT_REF_MAX_BYTES = 256;
/** Max field-name bytes for KG locators (UTF-8). */
export const AGENT_KG_FIELD_MAX_BYTES = 128;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface CheckedIdentity { hasUrl: boolean; url: string; provider: string; query: string; nodeId?: string; }

/** Source-identity check: exactly one of non-empty canonicalUrl or structured identity (url XOR identity). Returns the normalized identity or a rejection reason. */
function checkSourceIdentity(sourceRef: unknown): { ok: true; value: CheckedIdentity } | { ok: false; reason: string } {
  if (!isRecord(sourceRef)) return { ok: false, reason: 'source identity must be exactly one of canonicalUrl or structured identity' };
  const rawUrl = sourceRef['canonicalUrl'];
  const hasUrl = typeof rawUrl === 'string' && rawUrl.trim() !== '';
  const hasIdentity = sourceRef['identity'] !== undefined;
  if (hasUrl === hasIdentity) return { ok: false, reason: 'source identity must be exactly one of canonicalUrl or structured identity' };
  if (hasUrl) {
    const url = normalizeUrl(rawUrl as string);
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'canonicalUrl must be an http(s) URL' };
    return { ok: true, value: { hasUrl: true, url, provider: '', query: '' } };
  }
  const raw = sourceRef['identity'];
  if (!isRecord(raw)) return { ok: false, reason: 'invalid structured identity' };
  const provider = typeof raw['provider'] === 'string' ? raw['provider'].trim() : '';
  if (provider === '' || Buffer.byteLength(provider, 'utf8') > AGENT_IDENTITY_PROVIDER_MAX_BYTES) return { ok: false, reason: 'invalid structured identity provider' };
  const query = typeof raw['query'] === 'string' ? raw['query'].trim() : '';
  if (query === '' || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) return { ok: false, reason: 'invalid structured identity query' };
  if (raw['nodeId'] === undefined) return { ok: true, value: { hasUrl: false, url: '', provider, query } };
  const nodeId = typeof raw['nodeId'] === 'string' ? raw['nodeId'].trim() : '';
  if (nodeId === '' || Buffer.byteLength(nodeId, 'utf8') > AGENT_IDENTITY_NODE_ID_MAX_BYTES) return { ok: false, reason: 'invalid structured identity nodeId' };
  return { ok: true, value: { hasUrl: false, url: '', provider, query, nodeId } };
}

/** Locator check: typed union with exact keys per variant. Char-range keeps the legacy document-class rules (integer offsets, contentLength bound, excerpt-length match). */
function checkLocator(locator: unknown, excerpt: string, contentLength: number | undefined): { ok: true; locator: AgentLocator } | { ok: false; reason: string } {
  if (!isRecord(locator)) return { ok: false, reason: 'invalid locator' };
  const keys = Object.keys(locator);
  const exact = (...wanted: string[]): boolean => keys.length === wanted.length && wanted.every((k) => keys.includes(k));
  if ('start' in locator || 'end' in locator) {
    if (!exact('start', 'end')) return { ok: false, reason: 'invalid locator' };
    const start = locator['start'];
    const end = locator['end'];
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) <= (start as number) || (contentLength !== undefined && (end as number) > contentLength)) return { ok: false, reason: 'invalid locator' };
    if ((end as number) - (start as number) !== excerpt.length) return { ok: false, reason: 'locator does not match excerpt length' };
    return { ok: true, locator: { start: start as number, end: end as number } };
  }
  if ('page' in locator) {
    if (!exact('page') || !Number.isInteger(locator['page']) || (locator['page'] as number) < 0) return { ok: false, reason: 'invalid locator' };
    return { ok: true, locator: { page: locator['page'] as number } };
  }
  if ('line' in locator) {
    if (!exact('line') || !Number.isInteger(locator['line']) || (locator['line'] as number) < 0) return { ok: false, reason: 'invalid locator' };
    return { ok: true, locator: { line: locator['line'] as number } };
  }
  if ('timestamp' in locator) {
    const ts = locator['timestamp'];
    if (!exact('timestamp') || typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) return { ok: false, reason: 'invalid locator' };
    return { ok: true, locator: { timestamp: ts } };
  }
  if ('ref' in locator) {
    const ref = locator['ref'];
    if (!exact('ref') || typeof ref !== 'string' || ref.trim() === '' || Buffer.byteLength(ref, 'utf8') > AGENT_REF_MAX_BYTES) return { ok: false, reason: 'invalid locator' };
    return { ok: true, locator: { ref } };
  }
  if ('nodeId' in locator || 'field' in locator) {
    if (!exact('nodeId', 'field')) return { ok: false, reason: 'invalid locator' };
    const nodeId = locator['nodeId'];
    const field = locator['field'];
    if (typeof nodeId !== 'string' || nodeId.trim() === '' || Buffer.byteLength(nodeId, 'utf8') > AGENT_IDENTITY_NODE_ID_MAX_BYTES) return { ok: false, reason: 'invalid locator' };
    if (typeof field !== 'string' || field.trim() === '' || Buffer.byteLength(field, 'utf8') > AGENT_KG_FIELD_MAX_BYTES) return { ok: false, reason: 'invalid locator' };
    return { ok: true, locator: { nodeId, field } };
  }
  return { ok: false, reason: 'invalid locator' };
}

export function createAgentState({ goal }: { goal: string }): AgentState {
  if (typeof goal !== 'string' || Buffer.byteLength(goal, 'utf8') > MAX_GOAL_BYTES) {
    throw new RangeError('goal exceeds maximum bytes');
  }
  const state: AgentStateSnapshot = { goal, counters: { searchesUsed: 0, fetchesUsed: 0, rounds: 0 }, admittedEvidence: [], questions: [], queries: [] };
  const identity = (query: string, route: string, q?: string) => `${query.trim().toLowerCase()}\u0000${route.trim().toLowerCase()}\u0000${q ?? 'root'}`;
  const methods = {
    addEvidence(input: AgentEvidenceInput): (AgentEvidence & { mergedQuestions?: string[] }) | { rejected: { reason: string } } {
      // Content validation first (cap excluded: existing-id dedup-merge proceeds even at cap).
      // Legacy reason strings preserved verbatim for the web path: excerpt, documentHash,
      // canonicalUrl, locator, and status checks keep their exact messages and order.
      if (!input.excerpt || input.excerpt.trim() === '') return { rejected: { reason: 'excerpt is empty' } };
      if (Buffer.byteLength(input.excerpt, 'utf8') > AGENT_EVIDENCE_EXCERPT_MAX_BYTES) return { rejected: { reason: 'excerpt exceeds maximum bytes' } };
      if (!input.documentHash || input.documentHash.trim() === '') return { rejected: { reason: 'documentHash is required' } };
      const checkedIdentity = checkSourceIdentity(input.sourceRef);
      if (!checkedIdentity.ok) return { rejected: { reason: checkedIdentity.reason } };
      const proven = checkedIdentity.value;
      const route = (input.sourceRef as AgentSourceRef).acquisitionRoute;
      if (typeof route !== 'string' || !(AGENT_ACQUISITION_ROUTES as readonly string[]).includes(route)) return { rejected: { reason: 'unknown acquisition route' } };
      const checkedLocator = checkLocator(input.locator, input.excerpt, input.contentLength);
      if (!checkedLocator.ok) return { rejected: { reason: checkedLocator.reason } };
      // Legacy web routes pin the char-range locator: the fetch/report-suggested
      // path keeps byte-identical admission semantics; specialist routes use the
      // typed union (page/line/timestamp/ref/nodeId+field).
      if ((route === 'fetch' || route === 'report-suggested-fetch') && !('start' in checkedLocator.locator)) return { rejected: { reason: 'invalid locator' } };
      if (!['admitted', 'rejected', 'superseded'].includes(input.status)) return { rejected: { reason: 'unknown status' } };
      // admittedEvidence holds admitted entries only: rejected/superseded
      // inputs validate (unknown statuses still reject above) but never
      // touch state — no dedup-merge, no cap consumption, no push.
      if (input.status !== 'admitted') return { rejected: { reason: 'evidence status is not admitted' } };
      // Caller-supplied id/hash/fingerprint never trusted: always recomputed
      // from content. URL entries keep the legacy stable id
      // (sha256(normalizedUrl + excerptHash)); structured-identity entries key on
      // provider/query/nodeId, namespaced so the two spaces never collide.
      // Locator-aware (Wave 8, D7 option a): the typed locator joins the hash
      // ONLY for page/line/timestamp/ref/kg variants. Char-range locators
      // contribute nothing, so existing web/fetch ids stay byte-identical.
      const excerptHash = sha256(input.excerpt);
      const baseIdentityPart = proven.hasUrl ? proven.url : `structured-identity\u0000${proven.provider}\u0000${proven.query}\u0000${proven.nodeId ?? ''}`;
      const locator = checkedLocator.locator;
      let locatorPart = '';
      if ('page' in locator) locatorPart = `\u0000locator\u0000page\u0000${locator.page}`;
      else if ('line' in locator) locatorPart = `\u0000locator\u0000line\u0000${locator.line}`;
      else if ('timestamp' in locator) locatorPart = `\u0000locator\u0000timestamp\u0000${String(locator.timestamp)}`;
      else if ('ref' in locator) locatorPart = `\u0000locator\u0000ref\u0000${locator.ref}`;
      else if ('nodeId' in locator && 'field' in locator) locatorPart = `\u0000locator\u0000kg\u0000${locator.nodeId}\u0000${locator.field}`;
      const identityPart = baseIdentityPart + locatorPart;
      const id = `ev-${sha256(identityPart + excerptHash)}`;
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
        const kept = fresh.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, room);
        if (kept.length === 0) return existing;
        existing.questionIds.push(...kept);
        existing.questionIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        // Ephemeral marker ships on a COPY only: the stored entry never gains
        // the mergedQuestions key, so snapshots stay free of ephemeral keys.
        return { ...existing, mergedQuestions: kept };
      }
      if (state.admittedEvidence.length >= MAX_EVIDENCE) return { rejected: { reason: 'evidence limit reached' } };
      // Allowlist construction: unknown top-level/input keys never leak into state.
      // URL entries store the normalized URL with no identity key; structured
      // entries store canonicalUrl '' plus the allowlisted identity.
      const inputRef = input.sourceRef as AgentSourceRef;
      const evidence: AgentEvidence = { id, sourceRef: proven.hasUrl ? { canonicalUrl: proven.url, ...(inputRef.responseId === undefined ? {} : { responseId: inputRef.responseId }), sourceClass: inputRef.sourceClass, acquisitionRoute: inputRef.acquisitionRoute } : { canonicalUrl: '', identity: { provider: proven.provider, query: proven.query, ...(proven.nodeId === undefined ? {} : { nodeId: proven.nodeId }) }, ...(inputRef.responseId === undefined ? {} : { responseId: inputRef.responseId }), sourceClass: inputRef.sourceClass, acquisitionRoute: inputRef.acquisitionRoute }, documentHash: input.documentHash, locator: checkedLocator.locator, excerpt: input.excerpt, excerptHash, questionIds: sanitizeQuestionIds(input.questionIds), round: input.round, status: input.status, corroboratingFingerprint: corroboratingFingerprint(input.excerpt) };
      state.admittedEvidence.push(evidence);
      return evidence;
    },
    promoteToGrounded(questionId: string, evidenceIds: string[]) {
      const question = state.questions.find((q) => q.id === questionId);
      if (!question) return { rejected: { reason: 'unknown question id' } };
      if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return { rejected: { reason: 'evidenceIds must be non-empty' } };
      for (const id of evidenceIds) { const e = state.admittedEvidence.find((item) => item.id === id); if (!e || e.status !== 'admitted' || ('start' in e.locator && e.locator.end <= e.locator.start)) return { rejected: { reason: 'evidence id is not admitted' } }; }
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
