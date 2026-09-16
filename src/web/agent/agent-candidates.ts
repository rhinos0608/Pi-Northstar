// Wave 2 candidate routing (D6): typed discovery candidates.
//
// Candidates are navigation hints for follow-up gather compilation — they NEVER
// carry evidence IDs and NEVER enter the evidence ledger or admission paths.
// Kinds/fields mirror the D6 contract exactly; each kind compiles to its
// follow-up intent:
// - github-code {owner, repo, path, ref?, url} → github files intent
// - github-repo {owner, repo, url, description?} → issues/repo-scope intents
// - github-issue {owner, repo, number, url, title} → issue-read intent
// - research-source {source, title, url} → fetch intent
// - kg-entity {entityType, id, name?, url?} → kg_lookup intent
// - generic: rows lacking follow-up-compilable identity stay in the bounded
//   listing as display-only rows (never fabricated into a typed shape).
//
// Bounds: ≤12 new candidates per round AND ≤24 per job, deduped by
// kind+identity across rounds (first-seen wins, insertion order kept).

import { cleanUntrustedText } from '../../core/untrusted-content.js';
import type { AgentAcquisitionRoute } from './agent-state.js';

export type AgentCandidateKind =
  | 'github-code'
  | 'github-repo'
  | 'github-issue'
  | 'research-source'
  | 'kg-entity'
  | 'generic';

export interface GithubCodeCandidate {
  kind: 'github-code';
  route: 'github';
  owner: string;
  repo: string;
  path: string;
  ref?: string;
  url: string;
  title?: string;
  snippet?: string;
}

export interface GithubRepoCandidate {
  kind: 'github-repo';
  route: 'github';
  owner: string;
  repo: string;
  url: string;
  description?: string;
  title?: string;
  snippet?: string;
}

export interface GithubIssueCandidate {
  kind: 'github-issue';
  route: 'github';
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  snippet?: string;
}

export interface ResearchSourceCandidate {
  kind: 'research-source';
  route: 'research';
  source: string;
  title: string;
  url: string;
  snippet?: string;
}

export interface KgEntityCandidate {
  kind: 'kg-entity';
  route: 'kg';
  entityType: 'Person' | 'Organization';
  id: string;
  name?: string;
  url?: string;
  title?: string;
  snippet?: string;
}

export interface GenericCandidate {
  kind: 'generic';
  route: AgentAcquisitionRoute;
  title?: string;
  url?: string;
  snippet?: string;
}

export type AgentCandidate =
  | GithubCodeCandidate
  | GithubRepoCandidate
  | GithubIssueCandidate
  | ResearchSourceCandidate
  | KgEntityCandidate
  | GenericCandidate;

/** Max new candidates admitted per round (first-seen wins past the cap). */
export const MAX_CANDIDATES_PER_ROUND = 12;
/** Max accumulated candidates per job (first-seen wins past the cap). */
export const MAX_CANDIDATES_PER_JOB = 24;
/** Max candidates rendered into a model prompt section (most-recent wins). */
export const MAX_CANDIDATES_PER_PROMPT = 12;
/** Max bytes per rendered candidate line (UTF-8, truncate-not-reject). */
export const CANDIDATE_LINE_MAX_BYTES = 240;

/** Dedupe identity: kind + the fields a follow-up intent compiles from. */
export function candidateIdentity(candidate: AgentCandidate): string {
  switch (candidate.kind) {
    case 'github-code':
      return `github-code\u0000${candidate.owner}/${candidate.repo}@${candidate.ref ?? ''}:${candidate.path}`;
    case 'github-repo':
      return `github-repo\u0000${candidate.owner}/${candidate.repo}`;
    case 'github-issue':
      return `github-issue\u0000${candidate.owner}/${candidate.repo}#${candidate.number}`;
    case 'research-source':
      return `research-source\u0000${candidate.url}`;
    case 'kg-entity':
      return `kg-entity\u0000${candidate.entityType}:${candidate.id}`;
    case 'generic':
      return `generic\u0000${candidate.route}\u0000${candidate.title ?? ''}\u0000${candidate.url ?? ''}\u0000${candidate.snippet ?? ''}`;
  }
}

export interface AgentCandidateStore {
  readonly candidates: AgentCandidate[];
  readonly seen: ReadonlySet<string>;
}

interface MutableCandidateStore {
  candidates: AgentCandidate[];
  seen: Set<string>;
}

export function createCandidateStore(): AgentCandidateStore {
  const store: MutableCandidateStore = { candidates: [], seen: new Set() };
  return store as AgentCandidateStore;
}

/** Accumulate one round's candidates: dedupe by kind+identity across rounds,
 *  cap ≤12 new per round AND ≤24 per job. First-seen wins; returns the rows
 *  actually added (insertion order). Pure w.r.t. the ledger — no evidence IDs. */
export function addRoundCandidates(
  store: AgentCandidateStore,
  rows: readonly AgentCandidate[],
): { added: AgentCandidate[]; dropped: number } {
  const mutable = store as MutableCandidateStore;
  const added: AgentCandidate[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (added.length >= MAX_CANDIDATES_PER_ROUND) {
      dropped += 1;
      continue;
    }
    if (mutable.candidates.length >= MAX_CANDIDATES_PER_JOB) {
      dropped += 1;
      continue;
    }
    const key = candidateIdentity(row);
    if (mutable.seen.has(key)) {
      dropped += 1;
      continue;
    }
    mutable.seen.add(key);
    mutable.candidates.push(row);
    added.push(row);
  }
  return { added, dropped };
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Single-line, untrusted-safe rendering: invisible/control formatting
 *  stripped, newlines folded (one candidate per line — embedded newlines
 *  cannot become prompt structure), fence-shaped text defanged. */
function safeLine(value: string): string {
  const cleaned = cleanUntrustedText(value).replace(/[\n\r]+/g, ' ');
  return cleaned.replace(/<<</g, '< < <').replace(/>>>/g, '> > >');
}

function truncBytes(s: string, max: number): string {
  if (byteLen(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (byteLen(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** One deterministic prompt line per candidate, carrying the typed fields its
 *  follow-up intent compiles from. Display-only rows render without identity. */
export function formatCandidate(candidate: AgentCandidate): string {
  switch (candidate.kind) {
    case 'github-code': {
      const ref = candidate.ref === undefined ? '' : ` @${candidate.ref}`;
      const title = candidate.title === undefined ? '' : ` "${candidate.title}"`;
      return truncBytes(
        safeLine(`- [github-code] ${candidate.owner}/${candidate.repo} ${candidate.path}${ref} ${candidate.url}${title}`),
        CANDIDATE_LINE_MAX_BYTES,
      );
    }
    case 'github-repo': {
      const desc = candidate.description === undefined ? '' : ` — ${candidate.description}`;
      return truncBytes(
        safeLine(`- [github-repo] ${candidate.owner}/${candidate.repo} ${candidate.url}${desc}`),
        CANDIDATE_LINE_MAX_BYTES,
      );
    }
    case 'github-issue': {
      return truncBytes(
        safeLine(`- [github-issue] ${candidate.owner}/${candidate.repo}#${candidate.number} "${candidate.title}" ${candidate.url}`),
        CANDIDATE_LINE_MAX_BYTES,
      );
    }
    case 'research-source': {
      return truncBytes(
        safeLine(`- [research-source] (${candidate.source}) "${candidate.title}" ${candidate.url}`),
        CANDIDATE_LINE_MAX_BYTES,
      );
    }
    case 'kg-entity': {
      const name = candidate.name === undefined ? candidate.id : `${candidate.name} (${candidate.id})`;
      const url = candidate.url === undefined ? '' : ` ${candidate.url}`;
      return truncBytes(
        safeLine(`- [kg-entity] ${candidate.entityType}: ${name}${url}`),
        CANDIDATE_LINE_MAX_BYTES,
      );
    }
    case 'generic': {
      const parts = [candidate.title, candidate.url, candidate.snippet].filter(
        (part): part is string => part !== undefined && part !== '',
      );
      return truncBytes(safeLine(`- [${candidate.route}] ${parts.join(' · ')}`), CANDIDATE_LINE_MAX_BYTES);
    }
  }
}

/** Bounded candidates prompt section (most-recent ≤12). Empty input renders
 *  no lines — callers omit the section when there is nothing to navigate to. */
export function formatCandidatesSection(candidates: readonly AgentCandidate[]): string[] {
  return candidates.slice(-MAX_CANDIDATES_PER_PROMPT).map(formatCandidate);
}
