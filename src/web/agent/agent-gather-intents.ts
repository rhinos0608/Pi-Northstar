// GatherIntent: discriminated union of deterministic gather actions.
//
// Planner questions nest an intent (Atlas attaches real questionIds after
// normalizePlan); evaluator follow-ups carry questionId alongside the intent.
// Every variant compiles deterministically to exact native-tool arguments via
// compileIntentArgs. Graph is deferred from v1: natural language to arbitrary
// DQL/SPARQL is not a deterministic compilation step. KG access is therefore
// lookup-only: kg_lookup names a typed entity selector and compiles 1:1 to a
// native kg enhance call. No free-text query may ever compile to kg DQL.
//
// Validation is reject-never-clamp with fixed safe reasons only:
// 'unknown_intent_kind' | 'invalid_intent_shape'. No provider/model text
// ever enters reasons.
import { SOCIAL_PLATFORMS, type GatherActionLike, type SocialPlatform } from './agent-capabilities.js';

export type GithubSearchScope = 'repo' | 'code' | 'issues' | 'files';

/** Scope-discriminated github intent. Each scope carries ONLY the fields its
 *  native call reads (lossless by construction):
 *  - repo: free-text repo discovery → search_repos {query} (candidate-only rows).
 *  - code: text search, optional repoHint → search {query, repository?}
 *    (candidate-only rows; Wave 2 follow-up file reads compile from identity).
 *  - issues: bounded listing filter, NO query field — the native issues
 *    surface has no text selector (lists by repo/number/state/labels), so any
 *    query text would silently drop. Deferred: genuine issue text search needs
 *    a /search/issues native action (native `search` is /search/code only).
 *  - files: exact path + required repoHint → file {path, repository} (the
 *    native file action requires owner/repo, so repoHint rejects when absent). */
export type GithubSearchIntent =
  | { kind: 'github_search'; scope: 'repo'; query: string }
  | { kind: 'github_search'; scope: 'code'; query: string; repoHint?: string }
  | { kind: 'github_search'; scope: 'issues'; repoHint: string; state?: 'open' | 'closed' | 'all'; labels?: string[]; number?: number }
  | { kind: 'github_search'; scope: 'files'; query: string; repoHint: string };

export type GatherIntent =
  | { kind: 'web_search'; query: string; limit?: number }
  | { kind: 'research_search'; query: string; source?: string; yearFrom?: number; yearTo?: number; limit?: number }
  | GithubSearchIntent
  | { kind: 'social_search'; platform: SocialPlatform; query: string; sort?: string }
  | { kind: 'video_transcript'; videoHint: string }
  | { kind: 'kg_lookup'; entityType: 'Person' | 'Organization'; name?: string; url?: string; id?: string; limit?: number }
  /** Direct read of a research-source candidate URL (no search string).
   *  Exact keys {kind, url}: the url compiles to tools.fetchText(url) with no
   *  native tool call, consuming one gather action slot + one fetch attempt and
   *  never the maxSearches budget. sanitizeEvaluatorQuery never applies (not a
   *  search string); the url validates as a URL (http/https, 1..512 bytes,
   *  trimmed, no whitespace) so every typed research-source stays follow-up
   *  compilable per adaptResearchResult's httpUrl() promotion. */
  | { kind: 'web_fetch'; url: string };

export const GATHER_INTENT_KINDS = [
  'web_search',
  'research_search',
  'github_search',
  'social_search',
  'video_transcript',
  'kg_lookup',
  'web_fetch',
] as const;

export type GatherIntentKind = (typeof GATHER_INTENT_KINDS)[number];

export const GITHUB_SEARCH_SCOPES = ['repo', 'code', 'issues', 'files'] as const;

const GITHUB_ISSUE_STATES = ['open', 'closed', 'all'] as const;
const GITHUB_LABELS_MAX = 10;
const GITHUB_LABEL_MAX_BYTES = 50;

/** Label filter mirror of the native issues surface (≤10 non-empty ≤50B). */
function boundedLabels(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > GITHUB_LABELS_MAX) return false;
  return value.every((entry) => typeof entry === 'string' && byteLen(entry) >= 1 && byteLen(entry) <= GITHUB_LABEL_MAX_BYTES);
}

export type IntentValidationReason = 'unknown_intent_kind' | 'invalid_intent_shape';

export type ValidateIntentResult =
  | { ok: true; value: GatherIntent }
  | { ok: false; reason: IntentValidationReason };

const QUERY_MIN_BYTES = 8;
const QUERY_MAX_BYTES = 512;
const SOURCE_MAX_BYTES = 64;
const SORT_MAX_BYTES = 32;
const REPO_HINT_MAX_BYTES = 200;
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;
/** Native caps mirrored from the tool surface: WEB_SEARCH_LIMIT_MAX=20,
 *  research limit 1..30 (native-tools research comment + web contract),
 *  KG lookup limit 1..10 (compiles to the native enhance maxEntities cap,
 *  so the bound matches and never fails downstream). */
const WEB_SEARCH_LIMIT_MAX = 20;
const RESEARCH_SEARCH_LIMIT_MAX = 30;
const KG_LOOKUP_LIMIT_MAX = 10;
/** KG lookup selector bound: typed name/url/id strings, 1..512 bytes. */
const KG_SELECTOR_MAX_BYTES = 512;
/** web_fetch url bound: absolute http(s) URL, 1..512 bytes (mirrors the KG
 *  selector bound; trimmed with no whitespace — validated as a URL, never
 *  cleaned as a search string). */
const WEB_FETCH_URL_MAX_BYTES = 512;

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed !== value) return false;
  const n = byteLen(value);
  return n >= minBytes && n <= maxBytes;
}

function boundedInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const ALLOWED_KEYS: Record<GatherIntentKind, ReadonlySet<string>> = {
  web_search: new Set(['kind', 'query', 'limit']),
  research_search: new Set(['kind', 'query', 'source', 'yearFrom', 'yearTo', 'limit']),
  github_search: new Set(['kind', 'scope', 'query', 'repoHint', 'state', 'labels', 'number']),
  social_search: new Set(['kind', 'platform', 'query', 'sort']),
  video_transcript: new Set(['kind', 'videoHint']),
  kg_lookup: new Set(['kind', 'entityType', 'name', 'url', 'id', 'limit']),
  web_fetch: new Set(['kind', 'url']),
};

function exactKeys(record: Record<string, unknown>, kind: GatherIntentKind): boolean {
  const allowed = ALLOWED_KEYS[kind];
  return Object.keys(record).every((key) => allowed.has(key));
}

function checkLimit(raw: unknown, max: number): boolean {
  return raw === undefined || boundedInt(raw, 1, max);
}

/** Path-like rule for the github_search 'files' scope (compiled to an exact
 *  native path): absolute ('/...') or repo-relative with a slash
 *  ('src/agent.ts') or a dotted filename ('agent.ts'). Free text with
 *  whitespace never qualifies. Deterministic, fixed safe reason. */
function isPathLikeQuery(query: string): boolean {
  if (/\s/.test(query)) return false;
  if (query.startsWith('/')) return /^\/[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)*$/.test(query);
  if (query.includes('/')) return /^[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)+$/.test(query);
  return /^[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,10}$/.test(query);
}

/** Domain validator for one planner/evaluator-proposed intent. Exact keys per
 *  kind; bounded strings; integer ranges rejected, never clamped. */
export function validateGatherIntent(raw: unknown): ValidateIntentResult {
  if (!isRecord(raw)) return { ok: false, reason: 'invalid_intent_shape' };
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(GATHER_INTENT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'unknown_intent_kind' };
  }
  const k = kind as GatherIntentKind;
  if (!exactKeys(raw, k)) return { ok: false, reason: 'invalid_intent_shape' };
  switch (k) {
    case 'web_search': {
      if (!boundedText(raw.query, QUERY_MIN_BYTES, QUERY_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
      if (!checkLimit(raw.limit, WEB_SEARCH_LIMIT_MAX)) return { ok: false, reason: 'invalid_intent_shape' };
      return {
        ok: true,
        value: raw.limit === undefined
          ? { kind: 'web_search', query: raw.query as string }
          : { kind: 'web_search', query: raw.query as string, limit: raw.limit as number },
      };
    }
    case 'research_search': {
      if (!boundedText(raw.query, QUERY_MIN_BYTES, QUERY_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
      if (raw.source !== undefined && !boundedText(raw.source, 1, SOURCE_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
      if (raw.yearFrom !== undefined && !boundedInt(raw.yearFrom, YEAR_MIN, YEAR_MAX)) return { ok: false, reason: 'invalid_intent_shape' };
      if (raw.yearTo !== undefined && !boundedInt(raw.yearTo, YEAR_MIN, YEAR_MAX)) return { ok: false, reason: 'invalid_intent_shape' };
      if (
        typeof raw.yearFrom === 'number' &&
        typeof raw.yearTo === 'number' &&
        (raw.yearTo as number) < (raw.yearFrom as number)
      ) {
        return { ok: false, reason: 'invalid_intent_shape' };
      }
      if (!checkLimit(raw.limit, RESEARCH_SEARCH_LIMIT_MAX)) return { ok: false, reason: 'invalid_intent_shape' };
      return {
        ok: true,
        value: {
          kind: 'research_search',
          query: raw.query as string,
          ...(raw.source === undefined ? {} : { source: raw.source as string }),
          ...(raw.yearFrom === undefined ? {} : { yearFrom: raw.yearFrom as number }),
          ...(raw.yearTo === undefined ? {} : { yearTo: raw.yearTo as number }),
          ...(raw.limit === undefined ? {} : { limit: raw.limit as number }),
        },
      };
    }
    case 'github_search': {
      if (typeof raw.scope !== 'string' || !(GITHUB_SEARCH_SCOPES as readonly string[]).includes(raw.scope)) {
        return { ok: false, reason: 'invalid_intent_shape' };
      }
      const scope = raw.scope as GithubSearchScope;
      // Lossless-compile guards: each scope carries ONLY the fields its
      // native call reads (compileIntentArgs maps 1:1, never drops).
      if (scope === 'issues') {
        // Bounded listing filter: the native issues surface has no text
        // selector, so a query key rejects here instead of silently dropping.
        if (raw.query !== undefined) return { ok: false, reason: 'invalid_intent_shape' };
        if (!boundedText(raw.repoHint, 1, REPO_HINT_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
        if (raw.state !== undefined && !(GITHUB_ISSUE_STATES as readonly string[]).includes(raw.state as string)) {
          return { ok: false, reason: 'invalid_intent_shape' };
        }
        if (raw.labels !== undefined && !boundedLabels(raw.labels)) return { ok: false, reason: 'invalid_intent_shape' };
        if (raw.number !== undefined && !boundedInt(raw.number, 1, Number.MAX_SAFE_INTEGER)) {
          return { ok: false, reason: 'invalid_intent_shape' };
        }
        return {
          ok: true,
          value: {
            kind: 'github_search',
            scope,
            repoHint: raw.repoHint as string,
            ...(raw.state === undefined ? {} : { state: raw.state as 'open' | 'closed' | 'all' }),
            ...(raw.labels === undefined ? {} : { labels: [...(raw.labels as string[])] }),
            ...(raw.number === undefined ? {} : { number: raw.number as number }),
          },
        };
      }
      if (!boundedText(raw.query, QUERY_MIN_BYTES, QUERY_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
      if (raw.state !== undefined || raw.labels !== undefined || raw.number !== undefined) {
        return { ok: false, reason: 'invalid_intent_shape' };
      }
      if (raw.repoHint !== undefined && !boundedText(raw.repoHint, 1, REPO_HINT_MAX_BYTES)) {
        return { ok: false, reason: 'invalid_intent_shape' };
      }
      // 'repo' takes no repo selector (search_repos) so repoHint rejects here
      // instead of silently dropping; 'files' compiles query to an exact path
      // in a repo the native file action requires, so free-text queries and a
      // missing repoHint reject here instead of misfetching/failing at runtime.
      if (scope === 'repo' && raw.repoHint !== undefined) return { ok: false, reason: 'invalid_intent_shape' };
      if (scope === 'files') {
        if (!isPathLikeQuery(raw.query as string)) return { ok: false, reason: 'invalid_intent_shape' };
        if (!boundedText(raw.repoHint, 1, REPO_HINT_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
        return {
          ok: true,
          value: { kind: 'github_search', scope, query: raw.query as string, repoHint: raw.repoHint as string },
        };
      }
      return {
        ok: true,
        value: {
          kind: 'github_search',
          scope,
          query: raw.query as string,
          ...(raw.repoHint === undefined ? {} : { repoHint: raw.repoHint as string }),
        },
      };
    }
    case 'social_search': {
      if (typeof raw.platform !== 'string' || !(SOCIAL_PLATFORMS as readonly string[]).includes(raw.platform)) {
        return { ok: false, reason: 'invalid_intent_shape' };
      }
      if (!boundedText(raw.query, QUERY_MIN_BYTES, QUERY_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
      if (raw.sort !== undefined && !boundedText(raw.sort, 1, SORT_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
      return {
        ok: true,
        value: {
          kind: 'social_search',
          platform: raw.platform as SocialPlatform,
          query: raw.query as string,
          ...(raw.sort === undefined ? {} : { sort: raw.sort as string }),
        },
      };
    }
    case 'video_transcript': {
      if (!boundedText(raw.videoHint, QUERY_MIN_BYTES, QUERY_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
      return { ok: true, value: { kind: 'video_transcript', videoHint: raw.videoHint as string } };
    }
    case 'kg_lookup': {
      if (raw.entityType !== 'Person' && raw.entityType !== 'Organization') {
        return { ok: false, reason: 'invalid_intent_shape' };
      }
      // D1: typed selectors only — at least one of name/url/id, each a
      // bounded trimmed string. This kind has no free-text query field, so
      // no NL prose can ever reach kg DQL.
      let selectors = 0;
      for (const key of ['name', 'url', 'id'] as const) {
        const value = raw[key];
        if (value === undefined) continue;
        if (!boundedText(value, 1, KG_SELECTOR_MAX_BYTES)) return { ok: false, reason: 'invalid_intent_shape' };
        selectors += 1;
      }
      if (selectors === 0) return { ok: false, reason: 'invalid_intent_shape' };
      if (!checkLimit(raw.limit, KG_LOOKUP_LIMIT_MAX)) return { ok: false, reason: 'invalid_intent_shape' };
      return {
        ok: true,
        value: {
          kind: 'kg_lookup',
          entityType: raw.entityType as 'Person' | 'Organization',
          ...(raw.name === undefined ? {} : { name: raw.name as string }),
          ...(raw.url === undefined ? {} : { url: raw.url as string }),
          ...(raw.id === undefined ? {} : { id: raw.id as string }),
          ...(raw.limit === undefined ? {} : { limit: raw.limit as number }),
        },
      };
    }
    case 'web_fetch': {
      // Direct candidate-URL read: no query field, no search cleaning. The url
      // validates as an absolute http(s) URL (both schemes: httpUrl()
      // promotes http and https rows to research-source candidates, so an
      // HTTPS-only gate would strand http candidates). Reject-never-clamp.
      const url = raw.url;
      if (typeof url !== 'string') return { ok: false, reason: 'invalid_intent_shape' };
      if (url.trim() !== url || /\s/.test(url)) return { ok: false, reason: 'invalid_intent_shape' };
      // Zero-width/bidi formatting chars bypass the whitespace gate but smuggle
      // invisible URL differences: reject, never strip (reject-never-clamp).
      if (/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/.test(url)) return { ok: false, reason: 'invalid_intent_shape' };
      if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'invalid_intent_shape' };
      // Scheme alone is not a URL: require an actual host (no triple-slash
      // path-absolute form — WHATWG would read 'http:///path' as host 'path').
      if (!/^https?:\/\/[^/]/i.test(url)) return { ok: false, reason: 'invalid_intent_shape' };
      // Scheme alone is not a URL: require an actual host.
      try {
        const parsed = new URL(url);
        if (parsed.hostname === '') return { ok: false, reason: 'invalid_intent_shape' };
        if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'invalid_intent_shape' };
      } catch {
        return { ok: false, reason: 'invalid_intent_shape' };
      }
      const n = byteLen(url);
      if (n < 1 || n > WEB_FETCH_URL_MAX_BYTES) return { ok: false, reason: 'invalid_intent_shape' };
      return { ok: true, value: { kind: 'web_fetch', url } };
    }
  }
}

/** Ledger route for an intent (Task 6/7 owners extend admission; routes are
 *  plain strings in the query ledger). */
export type GatherIntentRoute = 'web' | 'research' | 'github' | 'social' | 'video' | 'kg';

export function intentRoute(intent: GatherIntent): GatherIntentRoute {
  switch (intent.kind) {
    case 'web_search':
      return 'web';
    case 'research_search':
      return 'research';
    case 'github_search':
      return 'github';
    case 'social_search':
      return 'social';
    case 'video_transcript':
      return 'video';
    case 'kg_lookup':
      return 'kg';
    case 'web_fetch':
      return 'web';
  }
}

/** Map an intent to the capability-snapshot admissibility gate input. */
export function intentToGatherActionLike(intent: GatherIntent): GatherActionLike {
  switch (intent.kind) {
    case 'web_search':
      return { kind: 'web_search' };
    case 'research_search':
      return { kind: 'research_search' };
    case 'github_search':
      return { kind: 'github' };
    case 'social_search':
      return { kind: 'social', platform: intent.platform };
    case 'video_transcript':
      return { kind: 'media_video', platform: 'youtube' };
    case 'kg_lookup':
      return { kind: 'kg' };
    case 'web_fetch':
      return { kind: 'fetch' };
  }
}

/** Search-dispatch text for an intent (pre-sanitize; the gather seam
 *  sanitizes again). video_transcript carries no query — its hint doubles;
 *  kg_lookup carries no query — its first selector doubles; the issues scope
 *  carries no query — its repoHint (plus #number when present) doubles.
 *  web_fetch carries no query — its url doubles (recorded verbatim in the
 *  ledger; never search-sanitized). */
export function actionSearchText(intent: GatherIntent): string {
  switch (intent.kind) {
    case 'web_fetch':
      return intent.url;
    case 'video_transcript':
      return intent.videoHint;
    case 'kg_lookup':
      return intent.name ?? intent.id ?? intent.url ?? '';
    case 'github_search':
      if (intent.scope === 'issues') {
        return intent.number === undefined ? intent.repoHint : `${intent.repoHint}#${intent.number}`;
      }
      return intent.query;
    default:
      return intent.query;
  }
}

/** Compile an intent to exact native-tool arguments per route (lossless:
 *  every validated field reaches the native call):
 *  web_search → web_search {query, limit?}; research_search → research
 *  {action:'academic', query, source?, limit?, yearFrom?} (yearTo rides along
 *  for the executor's client-side range filter — the native surface reads
 *  yearFrom only); github_search scopes → github {action, query/path,
 *  repository?, state?, labels?, number?} per github-request-contract
 *  selectors — 'repo' → search_repos {query} (no repo selector exists, so
 *  repoHint rejects at validation); 'code' → search {query, repository?};
 *  'issues' → issues {repository, state?, labels?, number?} (no text
 *  selector exists natively, so the intent carries no query field at all);
 *  'files' → file {path, repository} (native file requires owner/repo, so
 *  repoHint is required). Code/repo discovery rows surface as adapter
 *  candidates (search_result/repo entities stay candidate-only per the W1
 *  boundary); follow-up file/issue reads compile from candidate identity.
 *  social_search →
 *  social {platform, action:'search', query, sort?}; video_transcript →
 *  video {channel:'youtube', action:'transcript', url|id}; kg_lookup → kg
 *  {action:'enhance', type, name?/url?/id?, maxEntities?} (1:1 with the native
 *  enhance surface — type Person|Organization plus ≥1 selector, the intent
 *  limit mapping to maxEntities inside the native 1..10 cap). web_fetch → no
 *  native tool call: the executor runs tools.fetchText(intent.url) directly,
 *  so compilation is {url} (lossless: the single validated field). */
export function compileIntentArgs(intent: GatherIntent): Record<string, unknown> {
  switch (intent.kind) {
    case 'web_search':
      return { query: intent.query, ...(intent.limit === undefined ? {} : { limit: intent.limit }) };
    case 'research_search':
      return {
        action: 'academic',
        query: intent.query,
        ...(intent.source === undefined ? {} : { source: intent.source }),
        ...(intent.limit === undefined ? {} : { limit: intent.limit }),
        ...(intent.yearFrom === undefined ? {} : { yearFrom: intent.yearFrom }),
        ...(intent.yearTo === undefined ? {} : { yearTo: intent.yearTo }),
      };
    case 'github_search': {
      const repo = 'repoHint' in intent && intent.repoHint !== undefined ? { repository: intent.repoHint } : {};
      switch (intent.scope) {
        case 'repo':
          return { action: 'search_repos', query: intent.query };
        case 'code':
          return { action: 'search', query: intent.query, ...repo };
        case 'issues':
          return {
            action: 'issues',
            repository: intent.repoHint,
            ...(intent.state === undefined ? {} : { state: intent.state }),
            ...(intent.labels === undefined ? {} : { labels: [...intent.labels] }),
            ...(intent.number === undefined ? {} : { number: intent.number }),
          };
        case 'files':
          return { action: 'file', path: intent.query, ...repo };
      }
      break;
    }
    case 'social_search':
      return {
        platform: intent.platform,
        action: 'search',
        query: intent.query,
        ...(intent.sort === undefined ? {} : { sort: intent.sort }),
      };
    case 'video_transcript': {
      const hint = intent.videoHint;
      const selector = /^https?:\/\//i.test(hint) ? { url: hint } : { id: hint };
      return { channel: 'youtube', action: 'transcript', ...selector };
    }
    case 'kg_lookup':
      return {
        action: 'enhance',
        type: intent.entityType,
        ...(intent.name === undefined ? {} : { name: intent.name }),
        ...(intent.url === undefined ? {} : { url: intent.url }),
        ...(intent.id === undefined ? {} : { id: intent.id }),
        ...(intent.limit === undefined ? {} : { maxEntities: intent.limit }),
      };
    case 'web_fetch':
      return { url: intent.url };
  }
}
