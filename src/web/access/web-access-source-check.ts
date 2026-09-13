// Pi Web Access v0.29 additive-parity ingestion: source checking.
//
// Reimplemented semantics from pinned upstream source-check.ts (not copied):
// source-quality classification, sha256 content hashes, sentence-span passage
// extraction (<=400 chars, top 3 by term overlap), passage IDs `p-<rank>-<n>`,
// marker-based claim assessment with negation guard, dynamic confidence cap
// 0.85. Every assessment is explicitly heuristic (`heuristic: true`) — never
// factual adjudication.

import { createHash } from 'node:crypto';

export type WebAccessSourceQuality =
  | 'official_docs' | 'vendor_docs' | 'repo_issue' | 'blog' | 'forum' | 'news' | 'unknown';

export type WebAccessClaimStatus = 'supported' | 'contradicted' | 'unclear' | 'missing-evidence';

export interface WebAccessCheckSource {
  rank: number;
  url: string;
  title: string;
  snippet?: string | undefined;
  quality: WebAccessSourceQuality;
  fetched: boolean;
  fetch_error?: string | undefined;
  content_hash?: string | undefined;
}

export interface WebAccessCheckPassage {
  passage_id: string;
  source_url: string;
  source_rank: number;
  text: string;
  extraction_span?: { start: number; end: number } | undefined;
  content_hash?: string | undefined;
}

export interface WebAccessClaimAssessment {
  claim: string;
  status: WebAccessClaimStatus;
  supporting_passages: string[];
  contradicting_passages: string[];
  rationale: string;
  confidence: number;
}

export interface WebAccessSourceCheckArtifact {
  id: string;
  query: string;
  sources: WebAccessCheckSource[];
  passages: WebAccessCheckPassage[];
  claims?: WebAccessClaimAssessment[] | undefined;
  /** Always true: assessment is a marker heuristic, not factual adjudication. */
  heuristic: true;
  provider?: string | undefined;
}

export interface WebAccessSourceCheckInput {
  query: string;
  results: Array<{ title: string; url: string; snippet?: string | undefined; rank?: number | undefined }>;
  fetched?: Array<{ url: string; title: string; content: string; error?: string | undefined }> | undefined;
  claims?: string[] | undefined;
  provider?: string | undefined;
}

const OFFICIAL_DOCS_HOSTS = /^(developers\.|docs\.|learn\.|reference\.)|\.github\.io$/i;
const OFFICIAL_DOCS_PATHS = /\/(docs?|reference)(\/|\b)/i;
const VENDOR_DOCS_PATHS = /\/(documentation|docs?)\//i;
const REPO_ISSUE_PATHS = /\/(issues|pull|pulls)\//i;
const BLOG_HOSTS = /(medium\.com|substack\.com|dev\.to|hashnode\.)/i;
const BLOG_PATHS = /\/blogs?\//i;
const FORUM_HOSTS = /(stackoverflow\.com|serverfault\.com|superuser\.com|discourse\.|community\.)/i;
const FORUM_PATHS = /\/(forum|forums|threads)\//i;
const NEWS_HOSTS = /(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|cnet\.com|zdnet\.com)/i;
const NEWS_PATHS = /\/news(\/|$)/i;

const CONTRADICTION_MARKERS = ['not true', 'false', 'incorrect', 'debunked', 'retracted', 'no longer', 'never', 'denied', 'contrary', 'misleading'];
const SUPPORT_MARKERS = ['yes', 'true', 'correct', 'confirmed', 'according to', 'shows that', 'demonstrates', 'reported', 'verified', 'established'];

export function classifyWebAccessSource(url: string): WebAccessSourceQuality {
  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    return 'unknown';
  }
  if (REPO_ISSUE_PATHS.test(path)) return 'repo_issue';
  if (OFFICIAL_DOCS_HOSTS.test(host) || OFFICIAL_DOCS_PATHS.test(path)) return 'official_docs';
  if (VENDOR_DOCS_PATHS.test(path)) return 'vendor_docs';
  if (NEWS_HOSTS.test(host) || NEWS_PATHS.test(path)) return 'news';
  if (FORUM_HOSTS.test(host) || FORUM_PATHS.test(path)) return 'forum';
  if (BLOG_HOSTS.test(host) || BLOG_PATHS.test(path)) return 'blog';
  return 'unknown';
}

export function hashWebAccessContent(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3))];
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePhrasePattern(phrase: string): RegExp {
  const escaped = phrase.trim().toLowerCase().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i');
}

function markerIsNegated(value: string, pattern: RegExp): boolean {
  const match = pattern.exec(value);
  if (!match || match.index === undefined) return false;
  const matchedMarker = match[0].replace(/^[^a-z0-9]+/i, '');
  const before = value.slice(0, match.index + match[0].length - matchedMarker.length);
  return /(?:^|[^a-z0-9])(?:not|no|never|without)\s+$/i.test(before);
}

interface CompiledMarker { pattern: RegExp }

function compileMarkers(markers: string[]): CompiledMarker[] {
  return markers.map((marker) => ({ pattern: compilePhrasePattern(marker) }));
}

function hasCompiledMarker(value: string, compiled: readonly CompiledMarker[]): boolean {
  return compiled.some(({ pattern }) => pattern.test(value) && !markerIsNegated(value, pattern));
}

interface Span { text: string; start: number; end: number }

function extractSpans(content: string, hint: string): Span[] {
  const sentences: Span[] = [];
  const pattern = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  for (const match of content.matchAll(pattern)) {
    const raw = match[0];
    const text = raw.trim();
    if (text.length > 0 && text.length <= 400) {
      const start = (match.index ?? 0) + raw.indexOf(text);
      sentences.push({ text, start, end: start + text.length });
    }
  }
  const terms = tokenize(hint);
  if (terms.length === 0) return [];
  return sentences
    .map((sentence, index) => {
      const lowerText = sentence.text.toLowerCase();
      return {
        sentence, index,
        score: terms.filter((term) => lowerText.includes(term)).length,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map(({ sentence }) => sentence);
}

export function assessWebAccessClaim(claim: string, passages: WebAccessCheckPassage[]): WebAccessClaimAssessment {
  const terms = tokenize(claim);
  if (terms.length === 0 || passages.length === 0) {
    return {
      claim, status: 'missing-evidence', supporting_passages: [], contradicting_passages: [],
      rationale: 'No passages available that discuss the claim terms (heuristic assessment).', confidence: 0.2,
    };
  }
  const supporting: string[] = [];
  const contradicting: string[] = [];
  const termPatterns = terms.map(compilePhrasePattern);
  const contraMarkers = compileMarkers(CONTRADICTION_MARKERS);
  const supportMarkers = compileMarkers(SUPPORT_MARKERS);
  for (const passage of passages) {
    const lower = passage.text.toLowerCase();
    const overlap = termPatterns.filter((pattern) => pattern.test(lower)).length;
    const requiredOverlap = Math.min(terms.length, Math.max(2, Math.ceil(terms.length / 2)));
    if (overlap < requiredOverlap) continue;
    const contra = hasCompiledMarker(lower, contraMarkers);
    const support = hasCompiledMarker(lower, supportMarkers);
    if (contra && !support) contradicting.push(passage.passage_id);
    else if (support && !contra) supporting.push(passage.passage_id);
  }
  if (contradicting.length > 0 && supporting.length === 0) {
    return {
      claim, status: 'contradicted', supporting_passages: [], contradicting_passages: contradicting,
      rationale: `${contradicting.length} passage(s) contradict the claim; none support it (heuristic assessment).`,
      confidence: Math.min(0.85, 0.5 + contradicting.length * 0.1),
    };
  }
  if (supporting.length > 0 && contradicting.length === 0) {
    return {
      claim, status: 'supported', supporting_passages: supporting, contradicting_passages: [],
      rationale: `${supporting.length} passage(s) support the claim; none contradict it (heuristic assessment).`,
      confidence: Math.min(0.85, 0.5 + supporting.length * 0.1),
    };
  }
  if (supporting.length > 0 || contradicting.length > 0) {
    return {
      claim, status: 'unclear', supporting_passages: supporting, contradicting_passages: contradicting,
      rationale: `${supporting.length} supporting and ${contradicting.length} contradicting passage(s); evidence is mixed (heuristic assessment).`,
      confidence: 0.4,
    };
  }
  return {
    claim, status: 'unclear', supporting_passages: [], contradicting_passages: [],
    rationale: 'Passages mention the claim terms but contain no clear support or contradiction markers (heuristic assessment).',
    confidence: 0.3,
  };
}

export function buildWebAccessSourceCheck(
  input: WebAccessSourceCheckInput,
  deps: { now?: () => number; randomId?: () => string; clock?: { now(): number } } = {},
): WebAccessSourceCheckArtifact {
  const now = deps.clock?.now() ?? deps.now?.() ?? Date.now();
  const id = deps.randomId?.() ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const fetchedByUrl = new Map((input.fetched ?? []).map((page) => [page.url, page]));
  const sources: WebAccessCheckSource[] = [];
  const seen = new Set<string>();
  input.results.forEach((result, index) => {
    if (seen.has(result.url)) return;
    seen.add(result.url);
    const page = fetchedByUrl.get(result.url);
    const fetched = Boolean(page && !page.error && page.content);
    const source: WebAccessCheckSource = {
      rank: result.rank ?? index + 1,
      url: result.url,
      title: result.title,
      quality: classifyWebAccessSource(result.url),
      fetched,
    };
    if (result.snippet !== undefined) source.snippet = result.snippet;
    if (page?.error) source.fetch_error = page.error;
    else if (page && page.content) source.content_hash = hashWebAccessContent(page.content);
    sources.push(source);
  });
  const passages: WebAccessCheckPassage[] = [];
  for (const source of sources) {
    if (source.snippet) {
      passages.push({
        passage_id: `p-${source.rank}-0`,
        source_url: source.url,
        source_rank: source.rank,
        text: source.snippet,
        content_hash: hashWebAccessContent(source.snippet),
      });
    }
    const page = fetchedByUrl.get(source.url);
    if (page && !page.error && page.content) {
      const hint = source.snippet?.trim() || input.query;
      for (const [spanIndex, span] of extractSpans(page.content, hint).entries()) {
        passages.push({
          passage_id: `p-${source.rank}-${spanIndex + 1}`,
          source_url: source.url,
          source_rank: source.rank,
          text: span.text,
          extraction_span: { start: span.start, end: span.end },
          content_hash: hashWebAccessContent(span.text),
        });
      }
    }
  }
  const artifact: WebAccessSourceCheckArtifact = { id, query: input.query, sources, passages, heuristic: true };
  if (input.provider !== undefined) artifact.provider = input.provider;
  if (input.claims !== undefined) artifact.claims = input.claims.map((claim) => assessWebAccessClaim(claim, passages));
  return artifact;
}
