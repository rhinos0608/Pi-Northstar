// Stage 4 web slice: public-web search backends, semantic crawl/read
// fetching, and the shared helpers both paths use. Extracted from
// src/native-tools.ts; native-tools keeps thin delegation only.
//
// Contract-first: web_search routes to the 'search' action and fetch with a
// query routes to 'crawl' (query-less fetch is 'read'), validated by
// src/web-contract.ts before any backend dispatch. Out-of-range numeric
// fields reject with invalid_request — never silent clamp. Success paths
// build normalized 'article' entities via the contract validators and attach
// the canonical northstar envelope (northstarTextResult, same pattern as the
// research path). No raw backend_text passthrough.
//
// Selection: environment-only bounded policy (src/web-provider-policy.ts).
// Absent/blank PI_SEARCH_WEB_BACKENDS dispatches the first three configured
// preference entries; an explicit list dispatches every runnable entry
// concurrently (max 8). Duplicates, unknown IDs, and lists over 8 reject
// before any provider call. No retries — one request per selected adapter,
// including DuckDuckGo (single HTML call) and Codex.
//
// Fusion: uniform deterministic RRF over every fulfilled nonempty ranking,
// including Codex. First provider in selected order supplies the retained
// title/snippet for duplicate URLs; every {backend, rank} contributor is
// recorded. Provider-native AI (summaries/answers) never replaces retrieval
// snippets; normalized generated text rides details.nativeAi separately.
//
// SSRF boundaries: user URLs go through validateHttpUrl +
// resolvePublicHostname. unsafeFetchJson stays operator-owned only for the
// configured SearXNG base. The fetchPageText seam exists so tests can serve
// page HTML without touching the network or weakening production validation;
// production never sets it.

import type { BackendCallResult } from '../backend.js';
import { validateHttpUrl } from '../core/http.js';
import { normalizeUrl } from '../search/fusion.js';
import { chooseRepresentation } from './web-representation.js';
import { dedupeBy, northstarTextResult } from '../core/tool-output.js';
import type { DnsLookup } from '../network-policy.js';
import { codexConfigured, searchCodex } from './providers/codex-search.js';
import { BM25Index } from '../search/bm25.js';
import { chunkText as chunkTextSmart } from '../search/chunker.js';
import { VectorIndex } from '../search/vector-index.js';
import { EmbeddingClient } from '../sidecar/embedding-client.js';
import { acquireEmbeddingSidecar, type AcquiredSidecar } from '../sidecar/shared-sidecar.js';
import { ScraplingBridge } from './access/scrapling-bridge.js';
import { extractLinksFromHtml } from './access/link-extraction.js';
import { diffbotConfigured, searchDiffbot } from '../diffbot/diffbot-search.js';
import { createAnalyzeBudget, type AnalyzeBudget } from '../diffbot/diffbot-extract.js';
import { analyzeTextDiffbotKg, enhanceDiffbotKg } from '../diffbot/diffbot-kg.js';
import { buildNorthstarResult, parseEntity, type NorthstarEntityV1 } from '../result-contract.js';
import {
  resolveWebActionForTool,
  validateWebEntity,
  validateWebRequest,
  WEB_ENTITY_CONTENT_MAX,
  type WebArticleV1,
} from './web-contract.js';
import { exaSearchAdapter } from './providers/web-exa.js';
import { tavilySearchAdapter } from './providers/web-tavily.js';
import { braveSearchAdapter } from './providers/web-brave.js';
import { searxngSearchAdapter } from './providers/web-searxng.js';
import { ollamaSearchAdapter } from './providers/web-ollama.js';
import { duckduckgoSearchAdapter } from './providers/web-duckduckgo.js';
import { parallelSearchAdapter } from './providers/web-parallel.js';
import { parallelMcpSearchAdapter } from './providers/web-parallel-mcp.js';
import { tinyfishSearchAdapter } from './providers/web-tinyfish.js';
import { queritSearchAdapter } from './providers/web-querit.js';
import { valyuSearchAdapter } from './providers/web-valyu.js';
import { bochaSearchAdapter } from './providers/web-bocha.js';
import { xcrawlSearchAdapter } from './providers/web-xcrawl.js';
import { xaiSearchAdapter } from './providers/web-xai.js';
import { mistralSearchAdapter } from './providers/web-mistral.js';
import { brightdataSearchAdapter } from './providers/web-brightdata.js';
import { serpapiSearchAdapter } from './providers/web-serpapi.js';
import { serperSearchAdapter } from './providers/web-serper.js';
import {
  WEB_ACCESS_BATCH_CONCURRENCY,
  passesWebAccessFreshness,
  resolveWebAccessRecencyLowerBound,
  type WebAccessRecency,
} from './access/web-access-contract.js';
import { passesWebAccessDomainFilter } from './access/web-access-domain.js';
import { runAgentReport } from './web-agent-report.js';
import { runSitemap } from './web-sitemap.js';
import { firecrawlSearchAdapter } from './providers/firecrawl.js';
import { jinaSearchAdapter } from './providers/jina.js';
import { providerSignal, resolveWebProviderPolicy } from './web-provider-policy.js';
import { normalizeGeneratedText, resolveWebNativeAiPolicy } from './web-native-ai.js';
import { composeWebKnowledge, isKnowledgeEnrichmentEnabled, type WebKnowledgeBindings } from './web-knowledge-composition.js';
import {
  boundPageText,
  fetchReadablePage,
  type ReadablePage,
} from './web-page-reader.js';
export {
  ALL_FETCH_ADAPTERS,
  boundPageText,
  cleanText,
  fetchReadablePage,
  isDiffbotFallbackEligible,
  stripHtml,
  tryExternalFetch,
} from './web-page-reader.js';
export type { BoundedPageText, FetchPageRuntime, ReadablePage } from './web-page-reader.js';
import type {
  WebFusedSearchHit,
  WebGeneratedText,
  WebKnowledgeResult,
  WebProviderFailure,
  WebSearchAdapter,
  WebSearchHit,
  WebSearchProviderId,
} from './web-search-types.js';

export interface WebToolOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  lookup?: DnsLookup;
  /**
   * Test-only page-HTML seam. When set, fetchReadablePage serves HTML from
   * this function and skips validateHttpUrl + DNS preflight for those pages,
   * so crawl tests can run against a local http server that Scope A would
   * otherwise reject. Production never sets it; the default path still
   * validates every URL.
   */
  fetchPageText?: ((url: string, signal?: AbortSignal) => Promise<string>) | undefined;
}

export interface WebResult {
  title: string;
  url: string;
  snippet?: string | undefined;
  source?: string | undefined;
  rrfScore?: number | undefined;
  contributors?: Array<{ backend: string; rank: number }> | undefined;
}

export interface WebSearchBackend {
  name: string;
  configured: (env: Record<string, string | undefined>) => boolean;
  search: (query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal) => Promise<WebResult[]>;
}

const CATEGORY_HINTS: Record<string, string> = {
  company: 'official website leadership funding product pricing',
  'research paper': 'paper arxiv doi citation pdf',
  news: 'latest news report analysis',
  pdf: 'filetype:pdf',
  github: 'site:github.com repository source code',
  tweet: 'site:x.com OR site:twitter.com tweet thread',
  'personal site': 'personal website blog about',
  people: 'profile biography linkedin personal site',
  'financial report': 'annual report 10-k investor relations earnings',
};

/** Wrap a legacy WebResult-returning search in the shared adapter contract. */
function legacyAdapter(
  id: WebSearchProviderId,
  configured: (env: Record<string, string | undefined>) => boolean,
  search: (query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal) => Promise<WebResult[]>,
): WebSearchAdapter {
  return {
    id,
    configured,
    search: async (input): Promise<{ backend: WebSearchProviderId; hits: WebSearchHit[]; generatedText: WebGeneratedText[] }> => {
      const results = await search(input.query, input.limit, input.env, input.signal);
      return {
        backend: id,
        hits: results
          .filter((result) => typeof result.url === 'string' && result.url.length > 0)
          .map((result) => ({ title: result.title, url: result.url, snippet: result.snippet ?? '', backend: id })),
        generatedText: [],
      };
    },
  };
}

const diffbotSearchAdapter: WebSearchAdapter = legacyAdapter(
  'diffbot',
  (env) => diffbotConfigured(env),
  async (query, limit, env, signal) => {
    const rows = await searchDiffbot(query, limit, env, signal);
    return rows.map((row) => ({ title: row.title, url: row.url, ...(row.snippet !== undefined ? { snippet: row.snippet } : {}), source: 'diffbot' }));
  },
);
const codexSearchAdapter: WebSearchAdapter = legacyAdapter(
  'codex',
  (env) => codexConfigured(env),
  async (query, limit, env, signal) => {
    const rows = await searchCodex(query, limit, env, signal);
    return rows.map((row) => ({ title: row.title, url: row.url, ...(row.snippet !== undefined ? { snippet: row.snippet } : {}), source: 'codex' }));
  },
);

/** Every search adapter the bounded selection policy may dispatch. */
const ALL_SEARCH_ADAPTERS: readonly WebSearchAdapter[] = [
  tavilySearchAdapter,
  exaSearchAdapter,
  braveSearchAdapter,
  diffbotSearchAdapter,
  firecrawlSearchAdapter,
  jinaSearchAdapter,
  searxngSearchAdapter,
  ollamaSearchAdapter,
  duckduckgoSearchAdapter,
  codexSearchAdapter,
  parallelSearchAdapter,
  parallelMcpSearchAdapter,
  tinyfishSearchAdapter,
  queritSearchAdapter,
  valyuSearchAdapter,
  bochaSearchAdapter,
  xcrawlSearchAdapter,
  xaiSearchAdapter,
  mistralSearchAdapter,
  brightdataSearchAdapter,
  serpapiSearchAdapter,
  serperSearchAdapter,
];

/** RRF K factor, matching the shared fusion helper. */
const WEB_RRF_K = 60;

/**
 * Uniform deterministic fusion over selected-order rankings. Deduplicates by
 * normalizeUrl (richest donor keeps title/snippet via chooseRepresentation;
 * RRF score, provider index, contributor order, and final sort unchanged),
 * records every {backend, rank} contributor, and orders by RRF score, then
 * selected-provider index, then provider-local rank, then normalized URL.
 */
export function fuseWebSearchRankings(
  rankings: Array<{ backend: WebSearchProviderId; hits: WebSearchHit[] }>,
  limit: number,
): WebFusedSearchHit[] {
  interface Entry {
    hit: WebSearchHit;
    score: number;
    providerIndex: number;
    contributors: Array<{ backend: WebSearchProviderId; rank: number }>;
  }
  const byKey = new Map<string, Entry>();
  rankings.forEach((ranking, providerIndex) => {
    const seen = new Set<string>();
    ranking.hits.forEach((hit, localIndex) => {
      const key = normalizeUrl(hit.url);
      if (seen.has(key)) return;
      seen.add(key);
      const rank = localIndex + 1;
      const score = 1 / (WEB_RRF_K + rank);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { hit, score, providerIndex, contributors: [{ backend: ranking.backend, rank }] });
        return;
      }
      existing.score += score;
      existing.contributors.push({ backend: ranking.backend, rank });
      existing.hit = chooseRepresentation(existing.hit, hit);
    });
  });
  return [...byKey.entries()]
    .sort((a, b) => {
      if (b[1].score !== a[1].score) return b[1].score - a[1].score;
      if (a[1].providerIndex !== b[1].providerIndex) return a[1].providerIndex - b[1].providerIndex;
      const aRank = a[1].contributors[0]?.rank ?? 0;
      const bRank = b[1].contributors[0]?.rank ?? 0;
      if (aRank !== bRank) return aRank - bRank;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, limit)
    .map(({ 1: entry }) => ({
      title: entry.hit.title || entry.hit.url,
      url: entry.hit.url,
      snippet: entry.hit.snippet ?? '',
      backend: entry.hit.backend,
      ...(entry.hit.contentKind !== undefined ? { contentKind: entry.hit.contentKind } : {}),
      ...(entry.hit.publishedDate !== undefined ? { publishedDate: entry.hit.publishedDate } : {}),
      ...(entry.hit.author !== undefined ? { author: entry.hit.author } : {}),
      rrfScore: entry.score,
      contributors: entry.contributors,
    }));
}

function toProviderFailure(backend: WebSearchProviderId, error: unknown, callerSignal?: AbortSignal): WebProviderFailure {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const name = (error as { name?: unknown })?.name;
  if (callerSignal?.aborted || name === 'AbortError') return { backend, code: 'aborted', message, retryable: false };
  if (name === 'TimeoutError' || /timed out|timedout|aborted due to timeout|request timeout|provider timeout/i.test(message)) {
    return { backend, code: 'timeout', message, retryable: false };
  }
  if (/too large|exceeds maximum|exceeded size|response_too_large/i.test(message)) {
    return { backend, code: 'response_too_large', message, retryable: false };
  }
  if (/invalid|contract/i.test(message)) return { backend, code: 'invalid_response', message, retryable: false };
  return { backend, code: 'upstream_error', message, retryable: false };
}

/**
 * Translate frozen policy/policy-config errors into the legacy
 * caller-facing messages that predate the bounded-selection contract, so
 * explicit-misconfiguration rejections keep their established wording.
 * Selection-semantics errors (duplicate/count) pass through unchanged.
 */
function translateSelectionError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const unknownMatch = /unknown backend "([^"]+)"/.exec(message);
  if (unknownMatch) {
    throw new Error(`No known web search backends requested: ${unknownMatch[1]}`);
  }
  throw error;
}

interface DispatchedSearch {
  selected: WebSearchProviderId[];
  runnable: WebSearchProviderId[];
  unavailable: WebSearchProviderId[];
  timeoutMs: number;
  rankings: Array<{ backend: WebSearchProviderId; hits: WebSearchHit[] }>;
  generatedRaw: WebGeneratedText[];
  failures: WebProviderFailure[];
  servedBackends: string[];
}

export interface WebSearchQueryFields {
  includeContent?: boolean | undefined;
  recency?: WebAccessRecency | undefined;
  domains?: string[] | undefined;
  yearFrom?: number | undefined;
}

function hostnameOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Defense-in-depth post-filter shared by every fused hit. Adapters already
 * apply recency/domains provider-side; this keeps the runtime honest when a
 * provider ignores a filter. Dated hits at or after the intersected
 * recency+yearFrom lower bound pass; undated hits are retained without a
 * freshness claim. Domain excludes always drop; with at least one include
 * entry only matching hosts pass.
 */
export function applyWebQueryFieldFilters(hits: WebSearchHit[], fields: WebSearchQueryFields): WebSearchHit[] {
  const domains = fields.domains;
  const bound = resolveWebAccessRecencyLowerBound({ recency: fields.recency, yearFrom: fields.yearFrom });
  if ((domains === undefined || domains.length === 0) && bound === undefined) return hits;
  return hits.filter((hit) => {
    if (domains !== undefined && domains.length > 0) {
      const host = hostnameOf(hit.url);
      if (host === undefined) return false;
      if (!passesWebAccessDomainFilter(host, domains)) return false;
    }
    return passesWebAccessFreshness(hit.publishedDate, bound);
  });
}

/** Resolve policy + native-AI flags, then run every runnable adapter once. No retries. */
async function dispatchBoundedSearch(
  query: string,
  limit: number,
  env: Record<string, string | undefined>,
  callerSignal?: AbortSignal,
  fields: WebSearchQueryFields = {},
): Promise<DispatchedSearch> {
  const nativeAi = resolveWebNativeAiPolicy(env);
  let policy: ReturnType<typeof resolveWebProviderPolicy>;
  try {
    policy = resolveWebProviderPolicy(env, ALL_SEARCH_ADAPTERS);
  } catch (error) {
    translateSelectionError(error);
  }
  if (policy.runnable.length === 0) {
    if (policy.explicit) {
      throw new Error(`Requested web search backends are not configured: ${policy.selected.join(', ')}`);
    }
    return {
      selected: policy.selected,
      runnable: [],
      unavailable: policy.unavailable,
      timeoutMs: policy.timeoutMs,
      rankings: [],
      generatedRaw: [],
      failures: [],
      servedBackends: [],
    };
  }
  const settled = await Promise.allSettled(
    policy.runnable.map(async (adapter) => {
      // One composed caller+timeout signal per provider. The timer is unref'd
      // and self-clears on abort; nothing further to release after settle.
      const signal = providerSignal(callerSignal, policy.timeoutMs);
      return await adapter.search({
        query,
        limit,
        env,
        signal,
        nativeAi: { summaries: nativeAi.summaries, answers: nativeAi.answers },
        ...(fields.includeContent === true ? { includeContent: true as const } : {}),
        ...(fields.recency !== undefined ? { recency: fields.recency } : {}),
        ...(fields.domains !== undefined ? { domains: [...fields.domains] } : {}),
        ...(fields.yearFrom !== undefined ? { yearFrom: fields.yearFrom } : {}),
        ...(() => {
          const bound = resolveWebAccessRecencyLowerBound({ recency: fields.recency, yearFrom: fields.yearFrom });
          return bound === undefined ? {} : { freshnessLowerBoundMs: bound };
        })(),
      });
    }),
  );
  const rankings: Array<{ backend: WebSearchProviderId; hits: WebSearchHit[] }> = [];
  const generatedRaw: WebGeneratedText[] = [];
  const failures: WebProviderFailure[] = [];
  const servedBackends: string[] = [];
  settled.forEach((item, index) => {
    const adapter = policy.runnable[index]!;
    if (item.status === 'fulfilled') {
      servedBackends.push(adapter.id);
      // Degraded-but-resolved (e.g. Brave error envelope → empty hits): fusion
      // is unchanged, but the provenance gap is recorded so "one eye closed"
      // never reads as "nothing exists". Status-only, never thrown.
      if (item.value.degraded !== undefined) {
        failures.push({
          backend: adapter.id,
          code: 'upstream_error',
          message: `${adapter.id} search degraded: HTTP ${item.value.degraded.status} error envelope resolved to empty hits (provider failure, not zero results)`.slice(0, 500),
          retryable: false,
        });
      }
      const filtered = applyWebQueryFieldFilters(item.value.hits, fields);
      if (filtered.length > 0) rankings.push({ backend: adapter.id, hits: filtered });
      generatedRaw.push(...item.value.generatedText);
      return;
    }
    failures.push(toProviderFailure(adapter.id, item.reason, callerSignal));
  });
  return {
    selected: policy.selected,
    runnable: policy.runnable.map((adapter) => adapter.id),
    unavailable: policy.unavailable,
    timeoutMs: policy.timeoutMs,
    rankings,
    generatedRaw,
    failures,
    servedBackends,
  };
}

/**
 * Runtime Diffbot bindings for optional knowledge composition. No standalone
 * kg behavior changes: analyze_text maps excerpt + flags onto
 * analyzeTextDiffbotKg, enhance maps name/homepage selectors onto
 * enhanceDiffbotKg. Null when DIFFBOT_TOKEN is absent.
 */
function buildKnowledgeBindings(
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): WebKnowledgeBindings | null {
  const token = env.DIFFBOT_TOKEN?.trim();
  if (!token) return null;
  const ctxFor = (ctx?: { signal?: AbortSignal }): { token: string; signal?: AbortSignal } =>
    ({ token, ...(ctx?.signal !== undefined ? { signal: ctx.signal } : signal !== undefined ? { signal } : {}) });
  return {
    analyzeText: async (input, ctx) => {
      const outcome = await analyzeTextDiffbotKg(
        {
          text: input.text,
          extractEntities: input.extractEntities,
          extractFacts: input.extractFacts,
          extractTopics: input.extractTopics,
          extractSentiment: input.extractSentiment,
        },
        ctxFor(ctx),
      );
      if (outcome.error) throw new Error(outcome.error.message);
      return {
        entities: outcome.entities,
        mentions: outcome.mentions,
        facts: outcome.facts,
        topics: outcome.topics,
        ...(outcome.sentiment !== undefined ? { sentiment: outcome.sentiment } : {}),
      };
    },
    enhance: async (input, ctx) => {
      const outcome = await enhanceDiffbotKg(
        { type: input.type, ...input.selectors, maxEntities: input.maxEntities },
        ctxFor(ctx),
      );
      if (outcome.error) throw new Error(outcome.error.message);
      return { entities: outcome.entities, claims: outcome.claims ?? [] };
    },
  };
}

const UNAVAILABLE_KNOWLEDGE: WebKnowledgeResult = {
  status: 'unavailable',
  entities: [],
  mentions: [],
  facts: [],
  topics: [],
  partitions: [],
  skipped: [],
  salience: { status: 'unavailable', reason: 'provider_unsupported' },
};

export async function webSearch(args: Record<string, unknown>, options: WebToolOptions = {}): Promise<BackendCallResult> {
  const action = resolveWebActionForTool('web_search', args);
  const category = typeof args.category === 'string' ? args.category : undefined;
  const searchInput: { action: string; query?: string; queries?: unknown; limit?: number; includeContent?: unknown; recency?: unknown; domains?: unknown; yearFrom?: unknown; category?: string; cursor?: string; topK?: number; maxPages?: number; maxChars?: number; knowledge?: unknown } = { action };
  if (typeof args.query === 'string') searchInput.query = args.query;
  if (args.queries !== undefined) searchInput.queries = args.queries;
  if (typeof args.limit === 'number') searchInput.limit = args.limit;
  if (args.includeContent !== undefined) searchInput.includeContent = args.includeContent;
  if (args.recency !== undefined) searchInput.recency = args.recency;
  if (args.domains !== undefined) searchInput.domains = args.domains;
  if (args.yearFrom !== undefined) searchInput.yearFrom = args.yearFrom;
  if (category !== undefined) searchInput.category = category;
  if (typeof args.cursor === 'string') searchInput.cursor = args.cursor;
  if (typeof args.topK === 'number') searchInput.topK = args.topK;
  if (typeof args.maxPages === 'number') searchInput.maxPages = args.maxPages;
  if (typeof args.maxChars === 'number') searchInput.maxChars = args.maxChars;
  if (args.knowledge !== undefined) searchInput.knowledge = args.knowledge;
  if (args.mode !== undefined) (searchInput as { mode?: unknown }).mode = args.mode;
  const { request } = validateWebRequest(searchInput);
  const query = request.query ?? request.queries[0]!;
  const limit = request.limit;
  const env = options.env ?? process.env;
  const queryFields: WebSearchQueryFields = {
    ...(request.includeContent === true ? { includeContent: true as const } : {}),
    ...(request.recency !== undefined ? { recency: request.recency } : {}),
    ...(request.domains !== undefined ? { domains: request.domains } : {}),
    ...(request.yearFrom !== undefined ? { yearFrom: request.yearFrom } : {}),
  };
  if (request.agentMode && request.queries.length > 1) {
    throw new Error('mode "agent" supports a single query only');
  }
  if (request.agentMode) {
    const result = await runAgentReport(query, env, options.signal);
    options.signal?.throwIfAborted();
    const articles: WebArticleV1[] = [];
    for (const source of result.sources) {
      const article: WebArticleV1 = {
        version: 1,
        kind: 'article',
        id: source.url,
        url: source.url,
        source: result.provider,
        backend: result.provider,
        title: source.title || source.url,
      };
      if (validateWebEntity(article).ok) articles.push(article);
    }
    const agentEnvelope = buildNorthstarResult({
      request: { tool: 'web_search', channel: 'web', action: 'search' },
      outcomes: [{ source: 'web', backend: result.provider, entities: northstarArticles(articles) }],
      pagination: { supported: false, limit, hasMore: false },
    });
    return northstarTextResult(result.text, {
      query,
      effectiveQuery: query,
      results: result.sources.map((source) => ({ title: source.title, url: source.url, source: result.provider })),
      report: { status: 'ok', provider: result.provider, sources: result.sources.map((source) => ({ url: source.url, title: source.title })) },
    }, agentEnvelope);
  }
  const withCategoryHint = (text: string): string =>
    category && CATEGORY_HINTS[category] ? `${text} ${CATEGORY_HINTS[category]}` : text;
  const effectiveQuery = withCategoryHint(query);

  // Research isolation: category research/academic never touches generic web
  // providers (buildSearchRoute already routes those to the research tool).
  if (request.researchCategory) {
    const envelope = buildNorthstarResult({
      request: { tool: 'web_search', channel: 'web', action: 'search' },
      outcomes: [],
      pagination: { supported: false, limit, hasMore: false },
    });
    return northstarTextResult(formatWebResults(query, []), {
      query,
      effectiveQuery,
      category,
      results: [],
      fusion: { method: 'rrf', backends: [], failures: [], configuredBackends: [], selected: [], runnable: [], unavailable: [] },
    }, envelope);
  }

  const dispatchedQueries: Array<{ entry: string; dispatched: Awaited<ReturnType<typeof dispatchBoundedSearch>> }> = [];
  for (let index = 0; index < request.queries.length; index += WEB_ACCESS_BATCH_CONCURRENCY) {
    const batch = request.queries.slice(index, index + WEB_ACCESS_BATCH_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (entry) => ({
        entry,
        dispatched: await dispatchBoundedSearch(withCategoryHint(entry), limit, env, options.signal, queryFields),
      })),
    );
    dispatchedQueries.push(...settled);
  }
  // Caller cancellation propagates instead of collapsing into a backend-failure envelope.
  options.signal?.throwIfAborted();
  const combinedRankings: Array<{ backend: WebSearchProviderId; hits: WebSearchHit[] }> = [];
  const combinedGeneratedRaw: WebGeneratedText[] = [];
  const combinedFailures: WebProviderFailure[] = [];
  const servedList: string[] = [];
  const seenSelected = new Set<WebSearchProviderId>();
  const combinedSelected: WebSearchProviderId[] = [];
  const seenRunnable = new Set<WebSearchProviderId>();
  const combinedRunnable: WebSearchProviderId[] = [];
  const seenUnavailable = new Set<WebSearchProviderId>();
  const combinedUnavailable: WebSearchProviderId[] = [];
  for (const { dispatched } of dispatchedQueries) {
    combinedRankings.push(...dispatched.rankings);
    combinedGeneratedRaw.push(...dispatched.generatedRaw);
    combinedFailures.push(...dispatched.failures);
    for (const backend of dispatched.servedBackends) {
      if (!servedList.includes(backend)) servedList.push(backend);
    }
    for (const id of dispatched.selected) {
      if (!seenSelected.has(id)) {
        seenSelected.add(id);
        combinedSelected.push(id);
      }
    }
    for (const id of dispatched.runnable) {
      if (!seenRunnable.has(id)) {
        seenRunnable.add(id);
        combinedRunnable.push(id);
      }
    }
    for (const id of dispatched.unavailable) {
      if (!seenUnavailable.has(id)) {
        seenUnavailable.add(id);
        combinedUnavailable.push(id);
      }
    }
  }
  const dispatched = {
    selected: combinedSelected,
    runnable: combinedRunnable,
    unavailable: combinedUnavailable,
    rankings: combinedRankings,
    generatedRaw: combinedGeneratedRaw,
    failures: combinedFailures,
    servedBackends: servedList,
  };
  const fused = fuseWebSearchRankings(dispatched.rankings, limit);
  const generatedText = normalizeGeneratedText(dispatched.generatedRaw);

  let knowledge: WebKnowledgeResult | null = null;
  if (request.knowledge !== undefined && isKnowledgeEnrichmentEnabled(env)) {
    const bindings = buildKnowledgeBindings(env, options.signal);
    knowledge = bindings === null
      ? { ...UNAVAILABLE_KNOWLEDGE, entities: [], mentions: [], facts: [], topics: [], partitions: [], skipped: [] }
      : await composeWebKnowledge({ hits: fused, knowledge: request.knowledge, env, bindings, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
  }

  if (fused.length === 0 && dispatched.servedBackends.length === 0 && dispatched.failures.length > 0) {
    throw new Error(`All web search backends failed: ${dispatched.failures.map((failure) => `${failure.backend}: ${failure.message}`).join('; ')}`);
  }

  const legacyFailures = dispatched.failures.map((failure) => ({ backend: failure.backend, error: failure.message }));
  const { articles, invalid } = normalizeWebArticles(fused);
  const envelope = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'web', action: 'search' },
    outcomes: [
      ...dispatched.servedBackends.map((backend) => ({
        source: 'web',
        backend,
        entities: northstarArticles(articles.filter((article) => article.backend === backend)),
      })),
      ...legacyFailures.map((failure) => ({
        source: 'web',
        backend: failure.backend,
        error: { code: 'backend_http_error' as const, message: failure.error.slice(0, 500), retryable: false },
      })),
      ...(invalid > 0 ? [{ source: 'web', backend: 'native', invalid }] : []),
    ],
    pagination: { supported: false, limit, hasMore: false },
  });

  // Freshness provenance: when recency/yearFrom was requested, every retained
  // hit is labelled. Parseable dates passed the post-filter lower bound, so
  // they are verified; missing/unparseable dates were retained without a
  // freshness claim, so they are unverified rather than silently passing.
  const freshnessBound = resolveWebAccessRecencyLowerBound({ recency: queryFields.recency, yearFrom: queryFields.yearFrom });
  const freshnessOf = (publishedDate: string | undefined): 'verified' | 'unverified' =>
    publishedDate !== undefined && !Number.isNaN(Date.parse(publishedDate)) ? 'verified' : 'unverified';
  return northstarTextResult(formatWebResults(query, fused), {
    query,
    effectiveQuery,
    category,
    results: fused.map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      source: hit.backend,
      rrfScore: hit.rrfScore,
      contributors: hit.contributors.map((contributor) => ({ backend: contributor.backend, rank: contributor.rank })),
      ...(hit.publishedDate !== undefined ? { publishedDate: hit.publishedDate } : {}),
      ...(freshnessBound !== undefined ? { freshness: freshnessOf(hit.publishedDate) } : {}),
    })),
    fusion: {
      method: 'rrf',
      backends: dispatched.servedBackends,
      failures: legacyFailures,
      configuredBackends: dispatched.runnable,
      selected: dispatched.selected,
      runnable: dispatched.runnable,
      unavailable: dispatched.unavailable,
    },
    nativeAi: generatedText,
    ...(knowledge !== null ? { knowledge } : {}),
  }, envelope);
}

/**
 * Sitemap fetch: fetch({ url, siteMap: true, query?, maxPages? }).
 * siteMap is strict boolean; siteMap:true rejects searchQuery, followLinks,
 * topK, and maxChars before any dispatch. url required; maxPages defaults
 * to 10, caps at 25 (fetch-path conventions, enforced in runSitemap).
 * Tool text is a concise ordered URL list; details.siteMap carries status,
 * provider, baseUrl, urls, and the actual ranking method. Article entities
 * use the URL itself as title — no fabricated page content or titles.
 */
export async function siteMapFetch(args: Record<string, unknown>, options: WebToolOptions = {}): Promise<BackendCallResult> {
  if (typeof args.siteMap !== 'boolean') {
    throw new Error('siteMap must be a boolean');
  }
  for (const key of ['searchQuery', 'followLinks', 'topK', 'maxChars'] as const) {
    if (args[key] !== undefined) throw new Error(`${key} is not supported with siteMap`);
  }
  const url = requireString(args.url, 'url');
  const env = options.env ?? process.env;
  const query = typeof args.query === 'string' && args.query.trim().length > 0 ? args.query : undefined;
  if (args.query !== undefined && typeof args.query !== 'string') throw new Error('query must be a string');
  if (args.maxPages !== undefined && typeof args.maxPages !== 'number') {
    throw new Error('maxPages must be an integer in [1, 25]');
  }
  const result = await runSitemap(url, {
    ...(query !== undefined ? { query } : {}),
    ...(typeof args.maxPages === 'number' ? { maxPages: args.maxPages } : {}),
    env,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
  });
  options.signal?.throwIfAborted();
  const articles: WebArticleV1[] = [];
  for (const pageUrl of result.urls) {
    const article: WebArticleV1 = {
      version: 1,
      kind: 'article',
      id: pageUrl,
      url: pageUrl,
      source: 'web',
      backend: result.provider,
      title: pageUrl,
    };
    if (validateWebEntity(article).ok) articles.push(article);
  }
  const envelope = buildNorthstarResult({
    request: { tool: 'fetch', channel: 'web', action: 'read' },
    outcomes: [{ source: 'web', backend: result.provider, entities: northstarArticles(articles) }],
    pagination: { supported: false, limit: result.urls.length, hasMore: false },
  });
  const lines = result.urls.map((pageUrl, index) => `${index + 1}. ${pageUrl}`);
  const text = result.urls.length > 0
    ? `Sitemap for ${result.baseUrl}:\n${lines.join('\n')}`
    : `No sitemap URLs found for ${result.baseUrl}`;
  return northstarTextResult(text, {
    url,
    siteMap: {
      status: result.urls.length > 0 ? 'ok' : 'empty',
      provider: result.provider,
      baseUrl: result.baseUrl,
      urls: result.urls,
      ranking: result.ranking,
    },
  }, envelope);
}

export async function semanticCrawl(args: Record<string, unknown>, options: WebToolOptions = {}): Promise<BackendCallResult> {
  const query = requireString(args.query, 'query');
  const source = asRecord(args.source);
  const explicitUrlSource = source.type === 'url';
  const followLinks = Boolean(args.followLinks);
  const candidateUrl = (source.type === 'url' && typeof source.url === 'string' && source.url.trim())
    ? source.url.trim()
    : (typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined);
  if (followLinks && !candidateUrl) throw new Error('followLinks requires url as source');
  // Contract validation before dispatch: reject-on-out-of-range for topK /
  // maxPages / maxChars. The url here is shape-checked only (real SSRF
  // validation happens per page at fetch); search-source mode has no url yet
  // so it validates numerics against a shape-only placeholder that is never
  // fetched.
  const crawlInput: { action: string; query?: string; url?: string; topK?: number; maxPages?: number; maxChars?: number } = {
    action: 'crawl',
    query,
    url: candidateUrl ?? 'https://search.invalid/',
  };
  if (typeof args.topK === 'number') crawlInput.topK = args.topK;
  if (typeof args.maxPages === 'number') crawlInput.maxPages = args.maxPages;
  if (typeof args.maxChars === 'number') crawlInput.maxChars = args.maxChars;
  const { request: bounds } = validateWebRequest(crawlInput);
  const topK = bounds.topK;
  const maxPages = bounds.maxPages;
  const maxChars = bounds.maxChars;
  const maxDepth = followLinks ? 3 : (args.maxDepth != null ? Number(args.maxDepth) : (source.type === 'url' ? 1 : 0));
  // Shared per-fetch Diffbot Analyze budget: one instance across the whole BFS /
  // flat fetch so DIFFBOT_FALLBACK_BUDGET caps Analyze-GET calls per fetch
  // invocation. Created only when a token is present (no behavior without
  // DIFFBOT_TOKEN); out-of-range budget values throw, never clamp.
  const fallbackEnv = options.env ?? process.env;
  const fallbackBudget: AnalyzeBudget | undefined = fallbackEnv.DIFFBOT_TOKEN?.trim()
    ? createAnalyzeBudget(undefined, fallbackEnv)
    : undefined;
  const runtime = {
    ...(options.fetchPageText ? { fetchPageText: options.fetchPageText } : {}),
    env: fallbackEnv,
    ...(fallbackBudget ? { fallbackBudget } : {}),
  };
  let fallbackPages = 0;
  let externalPages = 0;
  const externalBackends = new Set<string>();
  const externalGenerated: WebGeneratedText[] = [];
  const primaryFailures: string[] = [];
  const noteFallback = (page: ReadablePage): void => {
    if (page.fallback) {
      fallbackPages++;
      if (page.primaryError) primaryFailures.push(page.primaryError);
    }
  };
  const noteExternal = (page: ReadablePage): void => {
    if (page.externalFetch) {
      externalPages++;
      externalBackends.add(page.externalFetch.backend);
      if (page.generatedText) externalGenerated.push(...page.generatedText);
      if (page.primaryError && !primaryFailures.includes(page.primaryError)) primaryFailures.push(page.primaryError);
    }
  };

  // Determine seed URLs: followLinks always starts from a single root URL
  let seedUrls: string[];
  if (followLinks) {
    seedUrls = [options.fetchPageText && candidateUrl ? candidateUrl : validateHttpUrl(candidateUrl!)];
  } else {
    seedUrls = dedupeBy(await semanticSourceUrls(source, query, maxPages, options.signal, options.env), normalizeUrl);
  }

  const bm25Index = new BM25Index();
  const indexedChunks: Array<{ id: string; url: string; title: string; content: string }> = [];
  let chunkCounter = 0;

  // Scrapling bridge for JS-rendered/Cloudflare pages (auto-detect)
  let bridge: ScraplingBridge | undefined;
  try {
    bridge = new ScraplingBridge({
      fetcher: 'stealthy',
      solveCloudflare: true,
      ...(followLinks ? { extractLinks: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env?.PI_SEARCH_SCRAPLING_PROXY ? { proxy: options.env.PI_SEARCH_SCRAPLING_PROXY } : {}),
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    const health = await bridge.health();
    if (!health.available) {
      await bridge.close();
      bridge = undefined;
    }
  } catch {
    if (bridge) await bridge.close();
    bridge = undefined;
  }

  try {
    if (followLinks) {
      // Bounded BFS crawl: frontier of {url, depth}, visited+scheduled sets, same-domain-only
      const visited = new Set<string>();
      const scheduled = new Set<string>();
      const rootUrl = new URL(seedUrls[0]!);
      const rootHost = rootUrl.hostname.replace(/^www\./, '');
      interface FrontierEntry { url: string; depth: number; }
      const frontier: FrontierEntry[] = [];
      for (const seed of seedUrls) {
        const norm = normalizeUrl(seed);
        if (!scheduled.has(norm)) {
          scheduled.add(norm);
          frontier.push({ url: seed, depth: 0 });
        }
      }
      let pagesAttempted = 0;

      while (frontier.length > 0) {
        if (options.signal?.aborted) break;
        if (pagesAttempted >= maxPages) break;
        const entry = frontier.shift()!;
        const normalized = normalizeUrl(entry.url);
        if (visited.has(normalized)) continue;
        if (entry.depth > maxDepth) continue;
        visited.add(normalized);

        pagesAttempted++;
        try {
          const page = await fetchReadablePage(entry.url, options.signal, bridge, options.lookup, runtime);
          noteFallback(page);
          noteExternal(page);

          // Index page content
          for (const chunk of chunkTextSmart(page.content)) {
            const id = String(chunkCounter++);
            bm25Index.add(id, chunk.text);
            indexedChunks.push({ id, url: page.url, title: page.title, content: chunk.text });
          }

          // Extract links and add to frontier (if within depth)
          if (entry.depth < maxDepth) {
            const pageLinks: string[] = page.links ?? [];
            // If bridge didn't return links, try extracting from raw HTML
            if (pageLinks.length === 0 && page.rawHtml) {
              pageLinks.push(...extractLinksFromHtml(page.rawHtml, page.url));
            }
            for (const link of pageLinks) {
              try {
                const linkHost = new URL(link).hostname.replace(/^www\./, '');
                if (linkHost === rootHost) {
                  const linkNorm = normalizeUrl(link);
                  if (!visited.has(linkNorm) && !scheduled.has(linkNorm)) {
                    scheduled.add(linkNorm);
                    frontier.push({ url: link, depth: entry.depth + 1 });
                  }
                }
              } catch {
                // Skip malformed URLs
              }
            }
          }
        } catch (err) {
          if (options.signal?.aborted) throw err;
          // Skip failed pages in BFS
        }
      }
    } else {
      // Original flat fetch loop (unchanged)
      for (const url of seedUrls.slice(0, maxPages)) {
        try {
          const page = await fetchReadablePage(url, options.signal, bridge, options.lookup, runtime);
          noteFallback(page);
          noteExternal(page);
          for (const chunk of chunkTextSmart(page.content)) {
            const id = String(chunkCounter++);
            bm25Index.add(id, chunk.text);
            indexedChunks.push({ id, url: page.url, title: page.title, content: chunk.text });
          }
        } catch (err) {
          // Rethrow on cancellation and SSRF/validation errors; ignore transient page failures.
          if (options.signal?.aborted) throw err;
          if (explicitUrlSource && err instanceof Error && /Private\/reserved|Blocked hostname|Disallowed URL scheme|URL credentials/.test(err.message)) throw err;
        }
      }
    }
  } finally {
    if (bridge) await bridge.close();
  }

  // Embedding pipeline (optional, degrades gracefully)
  let vectorIndex: VectorIndex | null = null;
  let embeddingClient: EmbeddingClient | null = null;
  const embeddingEnv = options.env ?? process.env;
  const embeddingEnabled = (() => {
    const v = embeddingEnv.PI_SEARCH_EMBEDDING_ENABLED;
    if (v === undefined) return true;
    return v !== '0' && v !== 'false';
  })();
  // Shared persistent sidecar: acquired per call, released (not stopped) so
  // the Python + SentenceTransformers process is reused across calls.
  // External EMBEDDING_SIDECAR_BASE_URL bypasses the local lifecycle.
  // Shutdown hooks in shared-sidecar.ts stop the child on process exit.
  let acquired: AcquiredSidecar | undefined;
  if (embeddingEnabled) {
    try {
      acquired = await acquireEmbeddingSidecar(embeddingEnv);
      embeddingClient = new EmbeddingClient({ baseUrl: acquired.baseUrl, ...(acquired.apiToken !== undefined ? { apiToken: acquired.apiToken } : {}) });
      // External sidecars are caller-managed — verify reachability; the
      // local singleton is already health-poll verified by ensureRunning.
      if (acquired.external) await embeddingClient.health();
      vectorIndex = new VectorIndex();

      // Embed all chunks
      const texts = indexedChunks.map(c => c.content);
      const vectors = await embeddingClient.embedBatch(texts);
      for (let i = 0; i < indexedChunks.length; i++) {
        vectorIndex.add(indexedChunks[i]!.id, vectors[i]!);
      }
    } catch (err) {
      // Graceful degradation: embedding unavailable, use BM25 only
      console.warn(`Embedding unavailable, falling back to BM25 only: ${err instanceof Error ? err.message : String(err)}`);
      vectorIndex = null;
      embeddingClient = null;
    }
  }

  let rankingMethod = 'bm25';

  let resultChunks: Array<{ id: string; url: string; title: string; content: string; score: number }> = [];
  if (vectorIndex && embeddingClient) {
    try {
      // Hybrid: BM25 + embedding with RRF fusion
      rankingMethod = 'bm25+embedding+rrf';
      const queryVec = await embeddingClient.embed(query);
      const bm25Results = bm25Index.search(query, topK * 2);
      const vecResults = vectorIndex.search(queryVec, topK * 2);

      const bm25Mapped = bm25Results.map(r => ({ id: r.id, score: r.score }));
      const vecMapped = vecResults.map(r => ({ id: r.id, score: r.score }));

      const { rrfMerge } = await import('../search/fusion.js');
      const fused = rrfMerge([bm25Mapped, vecMapped], { keyFn: (item: { id: string }) => item.id });

      resultChunks = fused
        .map(f => {
          const info = indexedChunks.find(c => c.id === f.item.id);
          return info ? { ...info, score: f.rrfScore } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
        .slice(0, topK);
    } catch (err) {
      console.warn(`Query embedding failed, using BM25 only: ${err instanceof Error ? err.message : String(err)}`);
      const ranked = bm25Index.search(query, topK);
      resultChunks = ranked
        .map(r => {
          const info = indexedChunks.find(c => c.id === r.id);
          return info ? { ...info, score: r.score } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
        .slice(0, topK);
    }
  } else {
    // BM25 only
    const ranked = bm25Index.search(query, topK);
    resultChunks = ranked
      .map(r => {
        const info = indexedChunks.find(c => c.id === r.id);
        return info ? { ...info, score: r.score } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .slice(0, topK);
  }
  acquired?.release();

  const fullText = resultChunks.length
    ? resultChunks.map((chunk, index) => `## ${index + 1}. ${chunk.title || chunk.url}\n${chunk.url}\n\n${chunk.content}`).join('\n\n')
    : `No crawl results for: ${query}`;
  // maxChars honored on crawl path too (same total-text bound as read).
  // Truncation stays visible: marker + counts ride inside maxChars budget.
  const bounded = boundPageText(fullText, maxChars);
  const truncated = bounded.truncated;
  const text = bounded.text;
  // Execution-fallback markers (not quality judgments): Diffbot Analyze or
  // gated external fetch supplied page(s) after native exhaustion. The
  // envelope degrades; details carry path/provider/qualityImpact plus the
  // safe primary failures.
  const fallbackUsed = fallbackPages > 0;
  const externalUsed = externalPages > 0;
  const degraded = fallbackUsed || externalUsed;
  const generatedText = normalizeGeneratedText(externalGenerated);
  const envelope = buildNorthstarResult({
    request: { tool: 'semantic_crawl', channel: 'web', action: 'crawl' },
    outcomes: [{
      source: 'web',
      backend: 'native-fetch',
      ...(degraded ? { degraded: true } : {}),
      entities: northstarArticles(resultChunks.map((chunk, index) => ({
        version: 1 as const,
        kind: 'article' as const,
        id: `${chunk.url}#chunk-${index}`,
        url: chunk.url,
        source: 'web',
        backend: 'native-fetch',
        title: chunk.title || chunk.url,
        snippet: chunk.content.slice(0, WEB_ENTITY_CONTENT_MAX),
      }))),
    }],
    pagination: { supported: false, limit: topK, hasMore: false },
    ...(degraded
      ? { notes: [`${fallbackPages + externalPages} page(s) supplied via execution fallback after native fetch exhaustion; primary failures in details; content quality not assessed.`] }
      : {}),
  });

  return northstarTextResult(text, {
    query,
    results: resultChunks,
    ranking: { method: rankingMethod, documentCount: bm25Index.stats().documentCount },
    maxChars,
    truncated,
    omittedChars: bounded.omittedChars,
    ...(fallbackUsed
      ? { fallback: { provider: 'diffbot', path: 'fallback', qualityImpact: 'not_assessed', pages: fallbackPages, primaryFailures: primaryFailures.slice(0, 10) } }
      : {}),
    ...(externalUsed
      ? {
        externalFetch: {
          backends: [...externalBackends],
          path: 'external-fetch',
          qualityImpact: 'not_assessed',
          pages: externalPages,
          primaryFailures: primaryFailures.slice(0, 10),
        },
      }
      : {}),
    ...(generatedText.length > 0 ? { generatedText } : {}),
  }, envelope);
}

async function semanticSourceUrls(source: Record<string, unknown>, query: string, maxPages: number, signal?: AbortSignal, env?: Record<string, string | undefined>): Promise<string[]> {
  if (source.type === 'url' && typeof source.url === 'string') return [source.url];
  const searchQuery = typeof source.query === 'string' ? source.query : query;

  // Shared bounded selection: identical rules to direct web_search.
  const effectiveEnv = env ?? process.env;
  let policy: ReturnType<typeof resolveWebProviderPolicy>;
  try {
    policy = resolveWebProviderPolicy(effectiveEnv, ALL_SEARCH_ADAPTERS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknownMatch = /unknown backend "([^"]+)"/.exec(message);
    if (unknownMatch) throw new Error(`Unknown web search backends: ${unknownMatch[1]}`);
    throw error;
  }
  if (policy.runnable.length === 0) {
    if (policy.explicit) {
      throw new Error(`No known web search backends configured (requested: ${policy.selected.join(', ')})`);
    }
    return [];
  }
  const nativeAi = resolveWebNativeAiPolicy(effectiveEnv);

  // Every runnable adapter dispatches once concurrently; no retries.
  const settled = await Promise.allSettled(
    policy.runnable.map(async (adapter) => adapter.search({
      query: searchQuery,
      limit: maxPages,
      env: effectiveEnv,
      signal: providerSignal(signal, policy.timeoutMs),
      nativeAi: { summaries: nativeAi.summaries, answers: nativeAi.answers },
    })),
  );
  const rankings: Array<{ backend: WebSearchProviderId; hits: WebSearchHit[] }> = [];
  settled.forEach((item, index) => {
    const adapter = policy.runnable[index]!;
    if (item.status === 'fulfilled' && item.value.hits.length > 0) {
      rankings.push({ backend: adapter.id, hits: item.value.hits });
    }
  });

  const composed = fuseWebSearchRankings(rankings, maxPages);

  // No semantic-source substitution: an empty composition yields no seeds.
  // (DDG is already in the backend list when configured.)
  if (composed.length === 0) return [];

  return composed.map(({ url }) => url).filter(Boolean).slice(0, maxPages);
}

export function formatWebResults(query: string, results: WebResult[]): string {
  if (results.length === 0) return `No web results for: ${query}`;
  return results.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet ?? ''}`).join('\n\n');
}

/** Normalize fused results to validated 'article' entities; invalid rows drop. */
function normalizeWebArticles(fused: WebFusedSearchHit[]): { articles: WebArticleV1[]; invalid: number } {
  const articles: WebArticleV1[] = [];
  let invalid = 0;
  for (const item of fused) {
    const article: WebArticleV1 = {
      version: 1,
      kind: 'article',
      id: item.url,
      url: item.url,
      source: item.backend,
      backend: item.backend,
      title: item.title || item.url,
      snippet: (item.snippet ?? '').slice(0, WEB_ENTITY_CONTENT_MAX),
    };
    if (validateWebEntity(article).ok) articles.push(article);
    else invalid++;
  }
  return { articles, invalid };
}

function northstarArticles(articles: WebArticleV1[]): NorthstarEntityV1[] {
  const entities: NorthstarEntityV1[] = [];
  for (const article of articles) {
    const parsed = parseEntity(
      { id: article.id, url: article.url, title: article.title, snippet: article.snippet, source: article.source },
      { source: article.source, kind: 'article' },
    );
    if (parsed.ok) entities.push(parsed.entity);
  }
  return entities;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(numberOrDefault(value, fallback)), min), max);
}

export function parseBackendOverride(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
}

export function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
