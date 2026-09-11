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
// SSRF boundaries: user URLs go through validateHttpUrl +
// resolvePublicHostname. unsafeFetchJson stays operator-owned only for the
// configured SearXNG base. The fetchPageText seam exists so tests can serve
// page HTML without touching the network or weakening production validation;
// production never sets it.

import type { BackendCallResult } from './backend.js';
import { fetchInit, fetchJson, fetchText, safeResponseJson, unsafeFetchJson, validateHttpUrl } from './http.js';
import { normalizeUrl, rrfMerge } from './fusion.js';
import { retryWithBackoff } from './retry.js';
import { dedupeBy, northstarTextResult } from './tool-output.js';
import { type DnsLookup, resolvePublicHostname } from './network-policy.js';
import { codexConfigured, searchCodex } from './codex-search.js';
import { BM25Index } from './bm25.js';
import { chunkText as chunkTextSmart } from './chunker.js';
import { VectorIndex } from './vector-index.js';
import { EmbeddingClient } from './embedding-client.js';
import { SidecarManager } from './sidecar-manager.js';
import { ScraplingBridge } from './scrapling-bridge.js';
import { extractLinksFromHtml } from './link-extraction.js';
import { diffbotConfigured, searchDiffbot } from './diffbot-search.js';
import { analyzePage, createAnalyzeBudget, type AnalyzeBudget } from './diffbot-extract.js';
import { DiffbotError } from './diffbot-transport.js';
import { buildNorthstarResult, parseEntity, type NorthstarEntityV1 } from './result-contract.js';
import {
  resolveWebActionForTool,
  validateWebEntity,
  validateWebRequest,
  WEB_ENTITY_CONTENT_MAX,
  type WebArticleV1,
} from './web-contract.js';

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
}

export interface WebSearchBackend {
  name: string;
  configured: (env: Record<string, string | undefined>) => boolean;
  search: (query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal) => Promise<WebResult[]>;
}

export const SEARCH_BACKENDS: WebSearchBackend[] = [
  { name: 'codex', configured: (env) => codexConfigured(env), search: searchCodex },
  { name: 'duckduckgo', configured: () => true, search: (query, limit, _env, signal) => searchDuckDuckGo(query, limit, signal) },
  { name: 'searxng', configured: (env) => Boolean(env.SEARXNG_BASE_URL?.trim()), search: searchSearxng },
  { name: 'brave', configured: (env) => Boolean(env.BRAVE_API_KEY?.trim()), search: searchBrave },
  { name: 'exa', configured: (env) => Boolean(env.EXA_API_KEY?.trim()), search: searchExa },
  { name: 'tavily', configured: (env) => Boolean(env.TAVILY_API_KEY?.trim()), search: searchTavily },
  { name: 'ollama-search', configured: (env) => Boolean((env.OLLAMA_SEARCH_BASE_URL ?? env.SEARCH_OLLAMA_BASE_URL)?.trim()), search: searchOllama },
  { name: 'diffbot', configured: (env) => diffbotConfigured(env), search: (query, limit, env, signal) => searchDiffbot(query, limit, env, signal) },
];

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

/**
 * Backend search with paid-call guard: a non-retryable DiffbotError
 * (contract/size/policy/HTTP-200 error envelope) never retries — the
 * shared retry helper sniffs message text and would otherwise re-fire
 * a paid call when the envelope text contains e.g. "timeout".
 * Retryable DiffbotErrors keep one retry (maxAttempts 2 semantics);
 * other backends use the shared helper unchanged.
 */
async function searchBackendWithRetry(
  backend: WebSearchBackend,
  query: string,
  limit: number,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<WebResult[]> {
  const maxAttempts = backend.name === 'duckduckgo' ? 1 : 2;
  if (backend.name !== 'diffbot') {
    return retryWithBackoff<WebResult[]>(
      () => backend.search(query, limit, env, signal),
      { maxAttempts, ...(signal ? { signal } : {}) },
    );
  }
  try {
    return await backend.search(query, limit, env, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DiffbotError && !error.retryable) throw error;
    if (maxAttempts <= 1) throw error;
    return retryWithBackoff<WebResult[]>(
      () => backend.search(query, limit, env, signal),
      { maxAttempts: 1, ...(signal ? { signal } : {}) },
    );
  }
}

export async function webSearch(args: Record<string, unknown>, options: WebToolOptions = {}): Promise<BackendCallResult> {
  const action = resolveWebActionForTool('web_search', args);
  const category = typeof args.category === 'string' ? args.category : undefined;
  const searchInput: { action: string; query?: string; limit?: number; category?: string; cursor?: string; topK?: number; maxPages?: number; maxChars?: number } = { action };
  if (typeof args.query === 'string') searchInput.query = args.query;
  if (typeof args.limit === 'number') searchInput.limit = args.limit;
  if (category !== undefined) searchInput.category = category;
  if (typeof args.cursor === 'string') searchInput.cursor = args.cursor;
  if (typeof args.topK === 'number') searchInput.topK = args.topK;
  if (typeof args.maxPages === 'number') searchInput.maxPages = args.maxPages;
  if (typeof args.maxChars === 'number') searchInput.maxChars = args.maxChars;
  const { request } = validateWebRequest(searchInput);
  const query = request.query!;
  const limit = request.limit;
  const effectiveQuery = category && CATEGORY_HINTS[category] ? `${query} ${CATEGORY_HINTS[category]}` : query;
  const env = options.env ?? process.env;
  const requested = parseBackendOverride(env.PI_SEARCH_WEB_BACKENDS);
  const unknownBackends = requested.filter((name) => !SEARCH_BACKENDS.some((backend) => backend.name === name));
  if (unknownBackends.length > 0) {
    throw new Error(`No known web search backends requested: ${unknownBackends.join(', ')}`);
  }
  const candidates = requested.length
    ? SEARCH_BACKENDS.filter((backend) => requested.includes(backend.name))
    : SEARCH_BACKENDS;
  const backends = candidates.filter((backend) => backend.configured(env));
  if (requested.length > 0 && backends.length === 0) {
    throw new Error(`Requested web search backends are not configured: ${requested.join(', ')}`);
  }
  const failures: Array<{ backend: string; error: string }> = [];

  const settled = await Promise.allSettled(backends.map(async (backend) => {
    const results = await searchBackendWithRetry(backend, effectiveQuery, limit, env, options.signal);
    return { backend: backend.name, results: results.map((result) => ({ ...result, source: result.source ?? backend.name })) };
  }));

  const outcome = collectBackendOutcome(settled, backends, failures);
  const fused = composePrimaryFirst(outcome.primary, outcome.rankings, limit);

  if (fused.length === 0 && failures.length > 0) {
    throw new Error(`All web search backends failed: ${failures.map((failure) => `${failure.backend}: ${failure.error}`).join('; ')}`);
  }

  const { articles, invalid } = normalizeWebArticles(fused);
  const envelope = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'web', action: 'search' },
    outcomes: [
      ...outcome.servedBackends.map((backend) => ({
        source: 'web',
        backend,
        entities: northstarArticles(articles.filter((article) => article.backend === backend)),
      })),
      ...failures.map((failure) => ({
        source: 'web',
        backend: failure.backend,
        error: { code: 'backend_http_error' as const, message: failure.error.slice(0, 500), retryable: true },
      })),
      ...(invalid > 0 ? [{ source: 'web', backend: 'native', invalid }] : []),
    ],
    pagination: { supported: false, limit, hasMore: false },
  });

  return northstarTextResult(formatWebResults(query, fused), {
    query,
    effectiveQuery,
    category,
    results: fused,
    fusion: {
      method: 'rrf',
      backends: outcome.servedBackends,
      failures,
      configuredBackends: backends.map((backend) => backend.name),
      ...(outcome.primary ? { primary: 'codex' } : {}),
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
  const primaryFailures: string[] = [];
  const noteFallback = (page: ReadablePage): void => {
    if (page.fallback) {
      fallbackPages++;
      if (page.primaryError) primaryFailures.push(page.primaryError);
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
  const externalSidecarUrl = embeddingEnv.EMBEDDING_SIDECAR_BASE_URL;

  if (embeddingEnabled) {
    try {
      if (externalSidecarUrl) {
        // External sidecar already running — use it directly
        embeddingClient = new EmbeddingClient({ baseUrl: externalSidecarUrl });
        await embeddingClient.health();
      } else {
        // Try spawning local sidecar
        const sidecar = new SidecarManager();
        await sidecar.ensureRunning();
        embeddingClient = new EmbeddingClient({ baseUrl: sidecar.getBaseUrl() });
      }
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

  const fullText = resultChunks.length
    ? resultChunks.map((chunk, index) => `## ${index + 1}. ${chunk.title || chunk.url}\n${chunk.url}\n\n${chunk.content}`).join('\n\n')
    : `No crawl results for: ${query}`;
  // maxChars is honored on the crawl path too (same total-text bound as read).
  const truncated = fullText.length > maxChars;
  const text = truncated ? fullText.slice(0, maxChars) : fullText;
  // Execution-fallback marker (not a quality judgment): when at least one
  // page came from Diffbot Analyze, the envelope degrades and details carry
  // path/provider/qualityImpact plus the safe primary failures.
  const fallbackUsed = fallbackPages > 0;
  const envelope = buildNorthstarResult({
    request: { tool: 'semantic_crawl', channel: 'web', action: 'crawl' },
    outcomes: [{
      source: 'web',
      backend: 'native-fetch',
      ...(fallbackUsed ? { degraded: true } : {}),
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
    ...(fallbackUsed
      ? { notes: [`Diffbot Analyze fallback supplied ${fallbackPages} page(s) after native fetch exhaustion; primary failures in details.fallback; content quality not assessed.`] }
      : {}),
  });

  return northstarTextResult(text, {
    query,
    results: resultChunks,
    ranking: { method: rankingMethod, documentCount: bm25Index.stats().documentCount },
    maxChars,
    truncated,
    ...(fallbackUsed
      ? { fallback: { provider: 'diffbot', path: 'fallback', qualityImpact: 'not_assessed', pages: fallbackPages, primaryFailures: primaryFailures.slice(0, 10) } }
      : {}),
  }, envelope);
}

export interface ReadablePage {
  url: string;
  title: string;
  content: string;
  rawHtml?: string;
  links?: string[];
  /**
   * Present when page text came from Diffbot Analyze fallback after
   * native/Scrapling exhaustion. Execution-path marker only:
   * qualityImpact is always 'not_assessed' — degraded never implies a
   * content-quality judgment.
   */
  fallback?: { provider: 'diffbot'; path: 'fallback'; qualityImpact: 'not_assessed' } | undefined;
  /** Safe (token-free, 500-char sliced) primary failure that triggered fallback. */
  primaryError?: string | undefined;
}

export interface FetchPageRuntime {
  fetchPageText?: ((url: string, signal?: AbortSignal) => Promise<string>) | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** Shared per-fetch Analyze budget (one instance across a whole crawl). */
  fallbackBudget?: AnalyzeBudget | undefined;
}

/**
 * Failure classes eligible for Diffbot Analyze fallback: network/upstream
 * errors, blocked responses, timeouts, empty/unusable content (handled by the
 * caller). Never: caller abort, policy/input/size/security/contract failures.
 */
export function isDiffbotFallbackEligible(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (error instanceof DiffbotError) return false;
  const name = (error as { name?: unknown })?.name;
  if (name === 'AbortError') return signal?.aborted ? false : true;
  const message = error instanceof Error ? error.message : String(error);
  if (/Disallowed URL scheme|URL credentials are not allowed|Blocked hostname|Private\/reserved|DNS resolved .* private\/reserved|DNS lookup aborted|credentials are never forwarded|too large|exceeded size|exceeds maximum|out of range|invalid_request|unsupported_action|unsupported_option|cursor_invalid|contract_invalid_response|response_too_large/i.test(message)) {
    return false;
  }
  return true;
}

export async function fetchReadablePage(
  rawUrl: string,
  signal?: AbortSignal,
  bridge?: ScraplingBridge,
  lookup?: DnsLookup,
  runtime?: FetchPageRuntime,
): Promise<ReadablePage> {
  const trimmed = rawUrl.trim();
  // Test seam: serve HTML without SSRF validation or network. Production
  // never sets fetchPageText, so every real fetch still validates below.
  // The seam also skips Diffbot fallback so tests stay deterministic.
  if (runtime?.fetchPageText) {
    const html = await runtime.fetchPageText(trimmed, signal);
    const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim());
    return { url: trimmed, title, content: stripHtml(html), rawHtml: html };
  }
  const url = validateHttpUrl(rawUrl);
  // DNS preflight: reject hostnames resolving to private/reserved IPs (matches browser path)
  await resolvePublicHostname(new URL(url).hostname, signal, lookup);

  let primaryError: unknown;
  // Analyze eligibility is tracked separately from the plain-fetch attempt:
  // an ineligible bridge/plain failure blocks paid Analyze but never blocks
  // a successful plain fetch. The first ineligible error is rethrown when
  // plain fetch also fails or yields no usable content.
  let analyzeBlockedError: unknown;
  // No behavior without DIFFBOT_TOKEN: legacy path returns bridge/plain
  // results directly with no eligibility gate and no second fetch.
  const envEarly = runtime?.env ?? process.env;
  const hasToken = Boolean(envEarly.DIFFBOT_TOKEN?.trim());
  // Try Scrapling bridge first (if provided and enabled). Empty bridge
  // content counts as unusable and falls through to plain fetch.
  if (bridge) {
    try {
      const result = await bridge.fetch(url);
      const content = stripHtml(result.content);
      if (content.trim()) {
        const links = Array.isArray(result.links) && result.links.length > 0 ? result.links : undefined;
        return { url: result.url, title: result.title || '', content, rawHtml: result.content, ...(links ? { links } : {}) };
      }
      if (!hasToken) {
        const links = Array.isArray(result.links) && result.links.length > 0 ? result.links : undefined;
        return { url: result.url, title: result.title || '', content, rawHtml: result.content, ...(links ? { links } : {}) };
      }
    } catch (error) {
      if (!hasToken) {
        // Legacy no-token path: bridge errors are ignored before plain fetch;
        // a plain-fetch failure below surfaces its own error, never this one.
      } else {
        primaryError ??= error;
        if (!isDiffbotFallbackEligible(error, signal)) analyzeBlockedError ??= error;
      }
      // Fall through to plain fetch in all cases; Analyze eligibility is
      // enforced after plain fetch, not here.
    }
  }

  let plainHtml: string | undefined;
  let plainTitle = '';
  try {
    const html = await fetchText(url, signal);
    const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim());
    plainHtml = html;
    plainTitle = title;
    const content = stripHtml(html);
    if (content.trim()) return { url, title, content, rawHtml: html };
    // Empty/unusable content: eligible for Analyze fallback (no primary error).
  } catch (error) {
    if (!hasToken) throw error;
    primaryError ??= error;
    if (!isDiffbotFallbackEligible(error, signal)) analyzeBlockedError ??= error;
    if (analyzeBlockedError) throw analyzeBlockedError;
  }
  if (analyzeBlockedError) throw analyzeBlockedError;

  // Diffbot Analyze-GET fallback: recoverable failures only, after
  // native/Scrapling exhaustion. No behavior without DIFFBOT_TOKEN.
  const env = runtime?.env ?? process.env;
  const token = env.DIFFBOT_TOKEN?.trim();
  if (!token) {
    if (primaryError) throw primaryError;
    const html = plainHtml ?? '';
    const title = plainTitle;
    return { url, title, content: stripHtml(html), rawHtml: html };
  }
  const budget = runtime?.fallbackBudget ?? createAnalyzeBudget(undefined, env);
  if (budget.remaining <= 0) {
    if (primaryError) throw primaryError;
    return { url, title: '', content: '', rawHtml: '' };
  }
  const safePrimary = primaryError
    ? (primaryError instanceof Error ? primaryError.message : String(primaryError)).slice(0, 500)
    : undefined;
  try {
    const analyzed = await analyzePage(url, {
      token,
      ...(signal !== undefined ? { signal } : {}),
      ...(lookup !== undefined ? { lookup } : {}),
      budget,
    });
    const links = Array.isArray(analyzed.links) && analyzed.links.length > 0 ? analyzed.links : undefined;
    return {
      url: analyzed.url,
      title: analyzed.title || '',
      content: analyzed.content,
      ...(links ? { links } : {}),
      fallback: { provider: 'diffbot', path: 'fallback', qualityImpact: 'not_assessed' },
      ...(safePrimary !== undefined ? { primaryError: safePrimary } : {}),
    };
  } catch {
    if (primaryError) throw primaryError;
    throw new Error('Diffbot Analyze fallback failed and the native fetch returned no usable content');
  }
}

async function semanticSourceUrls(source: Record<string, unknown>, query: string, maxPages: number, signal?: AbortSignal, env?: Record<string, string | undefined>): Promise<string[]> {
  if (source.type === 'url' && typeof source.url === 'string') return [source.url];
  const searchQuery = typeof source.query === 'string' ? source.query : query;

  // Use all configured backends (same logic as webSearch)
  const effectiveEnv = env ?? process.env;
  const requested = parseBackendOverride(effectiveEnv.PI_SEARCH_WEB_BACKENDS);
  const candidates = requested.length
    ? SEARCH_BACKENDS.filter((backend) => requested.includes(backend.name))
    : SEARCH_BACKENDS;
  const backends = candidates.filter((backend) => backend.configured(effectiveEnv));

  if (requested.length > 0 && backends.length === 0) {
    const unknown = requested.filter(r => !SEARCH_BACKENDS.some(b => b.name === r));
    if (unknown.length > 0) throw new Error(`Unknown web search backends: ${unknown.join(', ')}`);
    throw new Error(`No known web search backends configured (requested: ${requested.join(', ')})`);
  }

  // Query all configured backends in parallel
  const settled = await Promise.allSettled(backends.map(async (backend) => {
    const results = await backend.search(searchQuery, maxPages, effectiveEnv, signal);
    return { backend: backend.name, results };
  }));

  // Collect primary-first outcome (Codex first, RRF for the rest)
  const outcome = collectBackendOutcome(settled, backends, []);

  const composed = composePrimaryFirst(outcome.primary, outcome.rankings, maxPages);

  // No semantic-source substitution: an empty composition yields no seeds.
  // (DDG is already in the backend list when configured.)
  if (composed.length === 0) return [];

  return composed.map(({ url }) => url).filter(Boolean).slice(0, maxPages);
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  const data = await fetchJson(url.href, signal) as Record<string, unknown>;
  const related = flattenDuckDuckGoTopics(data.RelatedTopics).slice(0, limit);
  const heading = typeof data.Heading === 'string' ? data.Heading : '';
  const abstractUrl = typeof data.AbstractURL === 'string' ? data.AbstractURL : '';
  const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText : '';
  const results = [
    ...(abstractUrl ? [{ title: heading || query, url: abstractUrl, snippet: abstractText }] : []),
    ...related,
  ].slice(0, limit);
  return results.length ? results : searchDuckDuckGoHtml(query, limit, signal);
}

async function searchDuckDuckGoHtml(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const html = await fetchText(url.href, signal);
  return [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => ({
      title: stripHtml(match[2] ?? ''),
      url: decodeDuckDuckGoUrl(match[1] ?? ''),
      snippet: stripHtml(match[3] ?? ''),
    }))
    .filter((result) => result.url)
    .slice(0, limit);
}

async function searchSearxng(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const baseUrl = env.SEARXNG_BASE_URL?.trim();
  if (!baseUrl) return [];
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '1');
  const data = await unsafeFetchJson(url.href, { Accept: 'application/json' }, signal) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.content, ''),
    source: 'searxng',
  })).filter((result) => result.url);
}

async function searchBrave(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const apiKey = env.BRAVE_API_KEY?.trim();
  if (!apiKey) return [];
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));
  const data = await fetchJson(url.href, { Accept: 'application/json', 'X-Subscription-Token': apiKey }, signal) as { web?: { results?: Array<Record<string, unknown>> } };
  return (data.web?.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.description, ''),
    source: 'brave',
  })).filter((result) => result.url);
}

async function searchExa(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const apiKey = env.EXA_API_KEY?.trim();
  if (!apiKey) return [];
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    body: JSON.stringify({ query, numResults: limit, type: 'auto', useAutoprompt: true, contents: { text: true, highlights: true, summary: true } }),
    ...fetchInit({ Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': apiKey }, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for Exa`);
  const data = await safeResponseJson(response, 'https://api.exa.ai/search') as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.summary, stringField(result.text, '')),
    source: 'exa',
  })).filter((result) => result.url);
}

async function searchTavily(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) return [];
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    body: JSON.stringify({ query, max_results: Math.min(limit, 20), search_depth: 'basic', include_answer: 'basic', include_raw_content: false, include_images: false }),
    ...fetchInit({ Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for Tavily`);
  const data = await safeResponseJson(response, 'https://api.tavily.com/search') as { answer?: string; results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result, index) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: index === 0 && data.answer ? `${data.answer}\n\n${stringField(result.content, '')}` : stringField(result.content, ''),
    source: 'tavily',
  })).filter((result) => result.url);
}

async function searchOllama(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const baseUrl = (env.OLLAMA_SEARCH_BASE_URL ?? env.SEARCH_OLLAMA_BASE_URL)?.trim();
  if (!baseUrl) return [];
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const apiKey = (env.OLLAMA_SEARCH_API_KEY ?? env.SEARCH_OLLAMA_API_KEY)?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const searchUrl = `${baseUrl.replace(/\/+$/, '')}/api/experimental/web_search`;
  const response = await fetch(searchUrl, {
    method: 'POST',
    body: JSON.stringify({ query, max_results: limit }),
    ...fetchInit(headers, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for Ollama search`);
  const data = await safeResponseJson(response, searchUrl) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.content, ''),
    source: 'ollama-search',
  })).filter((result) => result.url);
}

function decodeDuckDuckGoUrl(raw: string): string {
  const decoded = raw.replace(/&amp;/g, '&');
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') ?? url.href;
  } catch {
    return decoded;
  }
}

function flattenDuckDuckGoTopics(value: unknown): WebResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (Array.isArray(record.Topics)) return flattenDuckDuckGoTopics(record.Topics);
    const text = typeof record.Text === 'string' ? record.Text : '';
    const url = typeof record.FirstURL === 'string' ? record.FirstURL : '';
    return url ? [{ title: text.split(' - ')[0] ?? text, url, snippet: text }] : [];
  });
}

export function formatWebResults(query: string, results: WebResult[]): string {
  if (results.length === 0) return `No web results for: ${query}`;
  return results.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet ?? ''}`).join('\n\n');
}

interface BackendOutcome {
  /** Codex results when it succeeded with at least one result (primary). */
  primary: WebResult[] | undefined;
  /** Non-Codex fulfilled rankings for RRF fusion. */
  rankings: WebResult[][];
  servedBackends: string[];
}

export function collectBackendOutcome(
  settled: PromiseSettledResult<{ backend: string; results: WebResult[] }>[],
  backends: WebSearchBackend[],
  failures: Array<{ backend: string; error: string }>,
): BackendOutcome {
  const outcome: BackendOutcome = { primary: undefined, rankings: [], servedBackends: [] };
  settled.forEach((item, index) => {
    const name = backends[index]?.name ?? 'unknown';
    if (item.status === 'fulfilled') {
      outcome.servedBackends.push(item.value.backend);
      const results = item.value.results;
      if (name === 'codex') {
        if (results.length > 0) outcome.primary = results;
      } else if (results.length > 0) {
        outcome.rankings.push(results);
      }
      return;
    }
    failures.push({ backend: name, error: item.reason instanceof Error ? item.reason.message : String(item.reason) });
  });
  return outcome;
}

/**
 * Primary-first result composition: Codex results keep their provider order at
 * the front (deduped by normalized URL); remaining slots are filled by
 * RRF-fused non-Codex rankings, appending only URLs not already present, up to
 * the requested limit. Without Codex results, plain RRF fusion is used.
 */
export function composePrimaryFirst(primary: WebResult[] | undefined, rankings: WebResult[][], limit: number): WebResult[] {
  const finish = (item: WebResult, rrfScore?: number): WebResult => ({
    ...item,
    ...(rrfScore !== undefined ? { rrfScore } : {}),
    title: item.title || item.url,
    snippet: item.snippet ?? '',
    source: item.source ?? 'unknown',
  });

  if (!primary || primary.length === 0) {
    return rrfMerge(rankings, { keyFn: (result) => normalizeUrl(result.url) })
      .slice(0, limit)
      .map(({ item, rrfScore }) => finish(item, rrfScore));
  }

  const seen = new Set<string>();
  const composed: WebResult[] = [];
  for (const item of primary) {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    composed.push(finish(item));
    if (composed.length >= limit) return composed;
  }
  for (const { item, rrfScore } of rrfMerge(rankings, { keyFn: (result) => normalizeUrl(result.url) })) {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    composed.push(finish(item, rrfScore));
    if (composed.length >= limit) return composed;
  }
  return composed;
}

/** Normalize fused results to validated 'article' entities; invalid rows drop. */
function normalizeWebArticles(fused: WebResult[]): { articles: WebArticleV1[]; invalid: number } {
  const articles: WebArticleV1[] = [];
  let invalid = 0;
  for (const item of fused) {
    const article: WebArticleV1 = {
      version: 1,
      kind: 'article',
      id: item.url,
      url: item.url,
      source: item.source ?? 'unknown',
      backend: item.source ?? 'unknown',
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

export function stripHtml(html: string): string {
  return cleanText(html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' '));
}

export function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
