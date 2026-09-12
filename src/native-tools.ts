import type { BackendCallResult } from './backend.js';
import { createAnalyzeBudget } from './diffbot-extract.js';
import {
  analyzeTextDiffbotKg,
  DIFFBOT_KG_ADAPTER_CURSOR_V,
  DIFFBOT_KG_MAX_FROM,
  DIFFBOT_KG_PROVIDER,
  enhanceDiffbotKg,
  searchDiffbotKg,
  type DiffbotKgOutcome,
  type DiffbotKgSpend,
  type DiffbotNlpOutcome,
} from './diffbot-kg.js';
import { DiffbotError, resolveDiffbotSpend, type DiffbotSpend } from './diffbot-transport.js';
import { callGithubTool } from './github-domain.js';
import type { KgIdentitySignals } from './knowledge-normalize.js';
import { aggregateKgTextAnalysis, dedupeKgEntities, groupKgEntitiesByIdentity, partitionEnhanceClaims, rrfRankKgEntities } from './knowledge-aggregate.js';
import {
  buildKnowledgeResult,
  KgContractError,
  validateKgEnhance,
  validateKgNlp,
  validateKgSearch,
  type KgAction,
  type KgAlignedGroup,
  type KgClaim,
  type KgEntity,
  type KgEntityEvidence,
  type KgError,
  type KgPartition,
  type KgSourceOutcome,
} from './knowledge-contract.js';
import {
  decodePinnedKgCursor,
  fingerprintKgRequest,
  issueKgCursor,
  KG_MAX_PROVIDERS_CEILING,
  planExplicitProviders,
  rejectCursorForExplicitFanout,
  runKgAuto,
  runKgFanout,
  selectAutoProviders,
} from './knowledge-domain.js';
import { callGraphTool } from './graph-tools.js';
import { guardResult, northstarTextResult, textResult } from './tool-output.js';
import { wrapUntrustedText } from './untrusted-content.js';
import { searchResearchPage } from './research-sources.js';
import { callReachTool } from './reach-tools.js';
import { ScraplingBridge } from './scrapling-bridge.js';
import { buildWebAccessStoredEntry, createWebAccessContentStore } from './web-access-content-store.js';
import { WEB_ACCESS_RETRIEVAL_MAX_CHARS, parseWebAccessFetchRequest, WebAccessContractError, type WebAccessProviderId, type WebAccessQueryResult } from './web-access-contract.js';
import { retrieveWebAccessCorpus } from './web-access-retrieve.js';
import { runWebAccessCachedSourceCheck } from './web-access-cached-source-check.js';
import { formatWebAccessSourceCheck } from './web-access-presentation.js';
import { isPdfUrl, extractWebAccessPdfText, loadUnpdfExtractor, WEB_ACCESS_PDF_MAX_BYTES } from './web-access-pdf.js';
import { selectWebAccessReaderKind } from './web-access-specialization.js';
import { validateHttpUrl } from './http.js';
import { resolvePublicHostname } from './network-policy.js';

const webAccessStore = createWebAccessContentStore();
import { buildNorthstarResult, parseEntity } from './result-contract.js';
import { resolveWebActionForTool, validateWebRequest } from './web-contract.js';
import {
  boundPageText,
  fetchReadablePage,
  requireString,
  semanticCrawl,
  siteMapFetch,
  webSearch,
  wordCount,
  type WebToolOptions,
} from './web.js';

type NativeToolName = 'web_search' | 'semantic_crawl' | 'fetch' | 'agentic_browse' | 'browse' | 'research' | 'github' | 'kg' | 'graph';

interface NativeToolOptions extends WebToolOptions {}

export async function callNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions = {},
): Promise<BackendCallResult> {
  const reachResult = await callReachTool(name, args, options);
  if (reachResult) return reachResult;

  return guardResult(await dispatchNativeTool(name, args, options), { env: options.env });
}

async function dispatchNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions,
): Promise<BackendCallResult> {
  switch (name as NativeToolName) {
    case 'web_search':
      return webSearchCached(args, options);
    case 'semantic_crawl':
      return semanticCrawl(args, options);
    case 'fetch': {
      // No hidden controls: provider selection is operator-only
      // (PI_SEARCH_WEB_BACKENDS) and format does not exist as fetch input.
      if (args.provider !== undefined) {
        throw new Error('provider selection is operator-only (PI_SEARCH_WEB_BACKENDS); omit provider');
      }
      if (args.format !== undefined) {
        throw new Error('format is not a supported fetch field');
      }
      // FINAL discriminated fetch: action retrieve/source_check served from the
      // bounded memory cache only (no network). Validation via the shared
      // contract; unknown responseIds throw ContractError with re-run guidance.
      if (typeof args.action === 'string') {
        const parsed = parseWebAccessFetchRequest(args);
        if (parsed && typeof (parsed as { action?: string }).action === 'string') {
          const kind = (parsed as { action: string }).action;
          if (kind === 'retrieve') {
            const req = parsed as { responseId: string; sourceIds?: string[]; offset?: number; limit?: number; findText?: string };
            try {
              const out = retrieveWebAccessCorpus(webAccessStore, req);
              return textResult(out.text, { action: 'retrieve', responseId: out.responseId, sources: out.sources, ...(out.matches !== undefined ? { matches: out.matches } : {}), ...(out.nextOffset !== undefined ? { nextOffset: out.nextOffset } : {}) });
            } catch (error) {
              if (error instanceof WebAccessContractError) throw new Error(error.message);
              throw error;
            }
          }
          const req = parsed as { responseId: string; claims: string[]; sourceIds?: string[] };
          try {
            const artifact = runWebAccessCachedSourceCheck(webAccessStore, req);
            return textResult(formatWebAccessSourceCheck(artifact as Parameters<typeof formatWebAccessSourceCheck>[0], null), { action: 'source_check', artifact });
          } catch (error) {
            if (error instanceof WebAccessContractError) throw new Error(error.message);
            throw error;
          }
        }
      }
      // Sitemap mode intercepts before read/crawl routing: strict boolean,
      // combos rejected inside siteMapFetch before any dispatch.
      if (args.siteMap !== undefined) {
        if (typeof args.siteMap !== 'boolean') throw new Error('siteMap must be a boolean');
        if (args.siteMap) return siteMapFetch(args, options);
      }
      // URL-array fetch: sequential readable reads in input order.
      if (Array.isArray(args.urls)) {
        // Defense-in-depth: forward the full url-array surface so contract
        // validation (urls readable-only, no followLinks/sitemap) also holds on
        // the direct callNativeTool path, not just the schema route.
        const parsed = parseWebAccessFetchRequest({ ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.url === 'string' ? { url: args.url } : {}), urls: args.urls, ...(typeof args.topK === 'number' ? { topK: args.topK } : {}), ...(typeof args.maxPages === 'number' ? { maxPages: args.maxPages } : {}), ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}), ...(args.followLinks !== undefined ? { followLinks: args.followLinks } : {}), ...(args.siteMap !== undefined ? { siteMap: args.siteMap } : {}) });
        void parsed;
        // urls + query honors the passage selector per URL: each URL is read
        // through the chunk-ranking crawl (same engine as singular url+query),
        // not returned as full text. Per-URL isolation: one failure becomes
        // an error entry, never an aborted array that loses prior results.
        const withQuery = typeof args.query === 'string' && args.query.trim().length > 0;
        const out: string[] = [];
        const cached: Array<{ title: string; url: string; snippet: string; content: string }> = [];
        for (const url of args.urls as unknown[]) {
          const single = String(url);
          try {
            if (withQuery) {
              const chunked = await semanticCrawl({
                source: { type: 'url', url: single },
                query: args.query,
                ...(typeof args.topK === 'number' ? { topK: args.topK } : {}),
                ...(typeof args.maxPages === 'number' ? { maxPages: args.maxPages } : {}),
                ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
              }, options);
              const body = resultToSingleText(chunked);
              out.push(`## ${single}\n${body}`);
              cached.push({ title: single, url: single, snippet: snippetOf(body), content: body });
            } else {
              const specialized = await dispatchSpecializedUrl(single, options);
              const singleResult = specialized ?? await agenticBrowse({ url: single, ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}) }, options);
              const body = resultToSingleText(singleResult);
              out.push(body);
              cached.push({ title: single, url: single, snippet: snippetOf(body), content: body });
            }
          } catch (error) {
            out.push(`## ${single}\nError: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`);
          }
        }
        const arrayQuery = withQuery && typeof args.query === 'string' ? args.query.trim() : 'fetch';
        return withFetchResponseId(
          textResult(out.join('\n\n'), { urls: args.urls }),
          cacheFetchEntries(arrayQuery, cached),
        );
      }
      // Internal specialization: query-less singular urls route through the
      // existing subsystems (local unpdf for PDF, github tool for repo/blob
      // urls, media tool for video urls, feeds tool for RSS/Atom urls).
      // Every specialist fails closed to undefined so unsupported shapes
      // fall through to the page reader. No format/provider input exists.
      if (typeof args.url === 'string' && args.query === undefined && args.searchQuery === undefined) {
        const specialized = await dispatchSpecializedUrl(args.url, options);
        if (specialized) return specialized;
      }
      // Contract-first routing: query-less fetch is read, fetch with a query
      // is crawl. resolveWebActionForTool validates before dispatch.
      // Crawl results populate the retrieve cache best-effort (never throws).
      const action = resolveWebActionForTool('fetch', args);
      if (action === 'read') return agenticBrowse(args, options);
      const crawled = await semanticCrawl(args, options);
      const crawlLabel =
        typeof args.query === 'string' && args.query.trim().length > 0
          ? args.query.trim()
          : typeof args.searchQuery === 'string'
            ? args.searchQuery
            : 'fetch';
      const crawlUrl = typeof args.url === 'string' ? args.url : crawlLabel;
      const crawlBody = resultToSingleText(crawled);
      return withFetchResponseId(crawled, cacheFetchForRetrieve({
        query: crawlLabel,
        title: crawlUrl,
        url: crawlUrl,
        snippet: snippetOf(crawlBody),
        content: crawlBody,
      }));
    }
    case 'agentic_browse':
      return agenticBrowse(args, options);
    case 'browse':
      return agenticBrowse({ action: 'read', ...args }, options);
    case 'research':
      return research(args, options);
    case 'github':
      return github(args, options);
    case 'kg':
      return kg(args, options);
    case 'graph':
      return callGraphTool(args, { env: options.env, signal: options.signal });
    default:
      throw new Error(`Unsupported native tool: ${name}`);
  }
}




function snippetOf(body: string): string {
  return body.slice(0, 500);
}

async function dispatchSpecializedUrl(url: string, options: NativeToolOptions): Promise<BackendCallResult | undefined> {
  const kind = selectWebAccessReaderKind(url);
  if (kind === 'pdf') return tryLocalPdfFetch(url, options);
  if (kind === 'github') return tryGithubUrlFetch(url, options);
  if (kind === 'media') return tryMediaUrlFetch(url, options);
  if (kind === 'feed') return tryFeedUrlFetch(url, options);
  return undefined;
}

function resultToSingleText(result: BackendCallResult): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
  }
  return '';
}

export function cacheWebSearchForRetrieve(query: string, hits: Array<{ title: string; url: string; snippet?: string; backend?: string }>): string | undefined {
  try {
    const trimmed = query.trim();
    if (!trimmed || hits.length === 0) return undefined;
    const byProvider = new Map<string, Array<{ title: string; url: string; snippet: string }>>();
    for (const hit of hits) {
      if (typeof hit.url !== 'string' || !hit.url) continue;
      const provider = typeof hit.backend === 'string' && hit.backend.length > 0 ? hit.backend : 'parallel';
      const list = byProvider.get(provider) ?? [];
      list.push({ title: typeof hit.title === 'string' ? hit.title : hit.url, url: hit.url, snippet: typeof hit.snippet === 'string' ? hit.snippet : '' });
      byProvider.set(provider, list);
    }
    if (byProvider.size === 0) return undefined;
    const results: WebAccessQueryResult[] = [...byProvider].map(([provider, results], index) => ({
      queryIndex: index,
      query: trimmed,
      response: { provider: provider as WebAccessProviderId, results },
    }));
    const entry = buildWebAccessStoredEntry({ queries: [trimmed], results });
    webAccessStore.put(entry);
    return entry.responseId;
  } catch {
    return undefined;
  }
}

async function webSearchCached(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const result = await webSearch(args, options);
  try {
    const details = (result as { details?: { query?: unknown; results?: Array<{ title: string; url: string; snippet?: string; source?: string; backend?: string }>; responseId?: unknown } }).details;
    if (details && typeof details.query === 'string' && Array.isArray(details.results) && details.responseId === undefined) {
      const hits = details.results.map((hit) => {
        const backend = typeof hit.backend === 'string' ? hit.backend : typeof hit.source === 'string' ? hit.source : undefined;
        return { title: hit.title, url: hit.url, snippet: hit.snippet ?? '', ...(backend !== undefined ? { backend } : {}) };
      });
      const responseId = cacheWebSearchForRetrieve(details.query, hits);
      if (responseId !== undefined) return { ...result, details: { ...details, responseId } };
    }
  } catch { /* best-effort cache; search result stands */ }
  return result;
}

// Fetch cache population: normal-fetch results (read/crawl/urls/pdf) are
// stored as single-query corpus entries so action retrieve/source_check can
// serve them cache-only. Best-effort: never throws, returns undefined when
// there is nothing worth caching.
export function cacheFetchEntries(
  query: string,
  entries: Array<{ title: string; url: string; snippet: string; content: string }>,
): string | undefined {
  try {
    const trimmed = query.trim();
    if (!trimmed || entries.length === 0) return undefined;
    const usable = entries.filter((e) => typeof e.url === 'string' && e.url.length > 0 && typeof e.content === 'string' && e.content.length > 0);
    if (usable.length === 0) return undefined;
    const results: WebAccessQueryResult[] = usable.map((entry, index) => ({
      queryIndex: index,
      query: trimmed,
      response: {
        provider: 'parallel',
        results: [{
          title: entry.title || entry.url,
          url: entry.url,
          snippet: entry.snippet.slice(0, 500),
        }],
        inlineContent: entry.content.slice(0, WEB_ACCESS_RETRIEVAL_MAX_CHARS),
      },
    }));
    const stored = buildWebAccessStoredEntry({ queries: [trimmed], results });
    webAccessStore.put(stored);
    return stored.responseId;
  } catch {
    return undefined;
  }
}

export function cacheFetchForRetrieve(input: { query: string; title: string; url: string; snippet: string; content: string }): string | undefined {
  return cacheFetchEntries(input.query, [{ title: input.title, url: input.url, snippet: input.snippet, content: input.content }]);
}

function withFetchResponseId(result: BackendCallResult, responseId: string | undefined): BackendCallResult {
  if (responseId === undefined) return result;
  const details = (result as { details?: Record<string, unknown> }).details;
  if (details !== undefined && typeof details === 'object' && details !== null && typeof (details as { responseId?: unknown }).responseId === 'string') {
    return result;
  }
  return { ...result, details: { ...(typeof details === 'object' && details !== null ? details : {}), responseId } };
}

// Map a github.com URL onto the existing github tool. Only repo roots and
// blob/tree paths map; issues/pulls/commits URLs return undefined so the
// page reader serves them. Validation rejects ambiguous refs (e.g. branch
// names containing slashes); callers fall through on any throw.
export function parseGithubFetchUrl(raw: string): Record<string, unknown> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return undefined;
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return undefined;
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/, '');
  if (!owner || !repo) return undefined;
  if (segs.length === 2) return { action: 'repo', owner, repo };
  const kind = segs[2];
  if ((kind === 'blob' || kind === 'tree') && segs.length >= 5) {
    const ref = segs[3];
    const path = segs.slice(4).join('/');
    if (!ref || !path) return undefined;
    return kind === 'blob'
      ? { action: 'file', owner, repo, path, ref }
      : { action: 'tree', owner, repo, path, ref };
  }
  return undefined;
}

async function tryGithubUrlFetch(url: string, options: NativeToolOptions): Promise<BackendCallResult | undefined> {
  try {
    const input = parseGithubFetchUrl(url);
    if (!input) return undefined;
    return await callGithubTool(input, {
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch {
    return undefined;
  }
}

async function tryMediaUrlFetch(url: string, options: NativeToolOptions): Promise<BackendCallResult | undefined> {
  try {
    return await callReachTool('video', { url }, options);
  } catch {
    return undefined;
  }
}

async function tryFeedUrlFetch(url: string, options: NativeToolOptions): Promise<BackendCallResult | undefined> {
  try {
    return await callReachTool('feeds', { url }, options);
  } catch {
    return undefined;
  }
}

async function tryLocalPdfFetch(url: string, options: NativeToolOptions): Promise<BackendCallResult | undefined> {
  try {
    if (!isPdfUrl(url)) return undefined;
    const extractor = await loadUnpdfExtractor();
    if (!extractor) return undefined;
    const validated = validateHttpUrl(url);
    await resolvePublicHostname(new URL(validated).hostname, options.signal, options.lookup);
    // SSRF redirect discipline: manual redirects with static + DNS preflight
    // on every hop (same pattern as http.ts fetchFollowingRedirects). A 30x
    // to a private/metadata target fails closed before any byte is fetched.
    let response: Response | undefined;
    let current = validated;
    for (let hop = 0; hop <= 10; hop++) {
      const hopResponse = await fetch(current, { redirect: "manual", ...(options.signal ? { signal: options.signal } : {}) });
      if (hopResponse.status < 300 || hopResponse.status >= 400) {
        response = hopResponse;
        break;
      }
      const location = hopResponse.headers.get("location");
      try { await hopResponse.body?.cancel(); } catch { /* cancel best-effort */ }
      if (!location || hop >= 10) return undefined;
      let next: string;
      try {
        next = validateHttpUrl(new URL(location, current).href);
      } catch {
        return undefined;
      }
      try {
        await resolvePublicHostname(new URL(next).hostname, options.signal, options.lookup);
      } catch {
        return undefined;
      }
      current = next;
    }
    if (!response || !response.ok) {
      if (response) { try { await response.body?.cancel(); } catch { /* cancel best-effort */ } }
      return undefined;
    }
    const announced = response.headers.get('content-length');
    if (announced !== null) {
      const size = Number(announced);
      if (Number.isFinite(size) && size > WEB_ACCESS_PDF_MAX_BYTES) {
        try { await response.body?.cancel(); } catch { /* cancel best-effort */ }
        return undefined;
      }
    }
    let buffer: Uint8Array;
    if (response.body !== null) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > WEB_ACCESS_PDF_MAX_BYTES) {
          try { await reader.cancel(); } catch { /* cancel best-effort */ }
          return undefined;
        }
        chunks.push(value);
      }
      buffer = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, at);
        at += chunk.byteLength;
      }
    } else {
      buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > WEB_ACCESS_PDF_MAX_BYTES) return undefined;
    }
    if (buffer.byteLength > WEB_ACCESS_PDF_MAX_BYTES) return undefined;
    const pdf = await extractWebAccessPdfText(buffer, { extractor, ...(options.signal ? { signal: options.signal } : {}) });
    return withFetchResponseId(
      textResult(pdf.text, { url, pdf: { totalPages: pdf.totalPages, truncated: pdf.truncated, citations: pdf.citations } }),
      cacheFetchForRetrieve({
        query: url,
        title: url.split('/').pop() || url,
        url,
        snippet: snippetOf(pdf.text),
        content: pdf.text,
      }),
    );
  } catch {
    return undefined;
  }
}

async function agenticBrowse(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'read';
  if (action !== 'read' && action !== 'browse') {
    throw new Error(`Native agentic_browse only supports read and browse actions, got: ${action}`);
  }

  const url = requireString(args.url, 'url');
  // Contract validation before dispatch: maxChars honored with
  // reject-on-out-of-range (same bound as the crawl path).
  const readInput: { action: string; url?: string; maxChars?: number } = { action: 'read', url };
  if (typeof args.maxChars === 'number') readInput.maxChars = args.maxChars;
  const { request } = validateWebRequest(readInput);
  const maxChars = request.maxChars;

  // Try Scrapling bridge if available (auto-detect)
  let bridge: ScraplingBridge | undefined;
  try {
    bridge = new ScraplingBridge({
      fetcher: 'stealthy',
      solveCloudflare: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env?.PI_SEARCH_SCRAPLING_PROXY ? { proxy: options.env.PI_SEARCH_SCRAPLING_PROXY } : {}),
    });
  } catch { /* use fallback */ }

  // Direct reads share the per-fetch Diffbot Analyze context (env + budget)
  // with the crawl path; fetchReadablePage stays token-free without DIFFBOT_TOKEN.
  const readEnv = options.env ?? process.env;
  const readRuntime = {
    ...(options.fetchPageText ? { fetchPageText: options.fetchPageText } : {}),
    env: readEnv,
    ...(readEnv.DIFFBOT_TOKEN?.trim() ? { fallbackBudget: createAnalyzeBudget(undefined, readEnv) } : {}),
  };
  try {
    const page = await fetchReadablePage(
      url,
      options.signal,
      bridge,
      options.lookup,
      readRuntime,
    );
    const bounded = boundPageText(page.content, maxChars);
    const content = bounded.text;
    const parsed = parseEntity(
      { id: page.url, url: page.url, title: page.title, snippet: bounded.shown.slice(0, 8000), source: 'web' },
      { source: 'web', kind: 'article' },
    );
    // Execution-fallback markers (not quality judgments): Diffbot Analyze
    // text or gated external fetch (Firecrawl/Jina) after native exhaustion
    // degrades the envelope, matching the crawl path. Vendor-generated
    // summaries ride details.generatedText separately, never merged into
    // content; external processing is always labeled.
    const fallbackUsed = page.fallback !== undefined;
    const externalUsed = page.externalFetch !== undefined;
    const degradedRead = fallbackUsed || externalUsed;
    const envelope = buildNorthstarResult({
      request: { tool: 'agentic_browse', channel: 'web', action: 'read' },
      outcomes: [{ source: 'web', backend: 'native-fetch', ...(degradedRead ? { degraded: true } : {}), entities: parsed.ok ? [parsed.entity] : [] }],
      pagination: { supported: false, limit: 1, hasMore: false },
      ...(fallbackUsed
        ? { notes: ['Diffbot Analyze fallback supplied page text after native fetch exhaustion; content quality not assessed.'] }
        : {}),
      ...(externalUsed
        ? { notes: ['Ordered external fetch supplied page text after native fetch exhaustion; content quality not assessed; external processing applied.'] }
        : {}),
    });
    // Read results populate the retrieve cache best-effort (never throws).
    const readResponseId = cacheFetchForRetrieve({
      query: url,
      title: page.title || page.url,
      url: page.url,
      snippet: snippetOf(bounded.shown),
      content,
    });
    return northstarTextResult(content, {
      url: page.url,
      title: page.title,
      content,
      ...(readResponseId !== undefined ? { responseId: readResponseId } : {}),
      wordCount: wordCount(content),
      truncated: bounded.truncated,
      maxChars,
      omittedChars: bounded.omittedChars,
      ...(fallbackUsed
        ? { fallback: { provider: 'diffbot', path: 'fallback', qualityImpact: 'not_assessed', ...(page.primaryError !== undefined ? { primaryFailure: page.primaryError } : {}) } }
        : {}),
      ...(externalUsed
        ? {
          externalFetch: {
            backend: page.externalFetch!.backend,
            externalProcessing: true as const,
            qualityImpact: 'not_assessed' as const,
            ...(page.primaryError !== undefined ? { primaryFailure: page.primaryError } : {}),
          },
        }
        : {}),
      ...(externalUsed && page.generatedText !== undefined && page.generatedText.length > 0
        ? { generatedText: page.generatedText }
        : {}),
    }, envelope);
  } finally {
    if (bridge) await bridge.close();
  }
}

async function research(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'academic';
  if (action !== 'academic') throw new Error(`Native research only supports academic action, got: ${action}`);

  const query = requireString(args.query, 'query');
  const source = typeof args.source === 'string' ? args.source : 'all';
  // Reject-on-out-of-range: research limit 1-30 rejects via the web contract
  // instead of silently clamping.
  const { request: bound } = validateWebRequest({
    action: 'search',
    query,
    category: 'research',
    limit: args.limit === undefined ? 12 : (args.limit as number),
  });
  const limit = bound.limit;
  // Every advertised source dispatches to its exact native adapter via the
  // research seam; unknown sources return an explicit error envelope, never a
  // DuckDuckGo/web substitution.
  const researchPageRequest: Parameters<typeof searchResearchPage>[0] = { query, source, limit };
  if (typeof args.yearFrom === 'number') researchPageRequest.yearFrom = args.yearFrom;
  if (typeof args.cursor === 'string' && args.cursor) researchPageRequest.cursor = args.cursor;
  if (options.signal) researchPageRequest.signal = options.signal;
  if (options.env) researchPageRequest.env = options.env;
  const envelope = await searchResearchPage(researchPageRequest, { requestedAction: action });

  const entities = envelope.data.kind === 'entities' ? envelope.data.entities : [];
  const results = entities.map((entity) => ({
    title: entity.title || entity.id,
    url: entity.url,
    snippet: entity.snippet ?? '',
    source: entity.source,
  }));
  let text = results.length
    ? results.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join('\n\n')
    : `No research results for: ${query}`;
  const failedSources = [...new Set(envelope.errors.map((error) => error.source))];
  if (envelope.status === 'error' && envelope.errors[0]) {
    text = `Research error (${envelope.request.source}): ${envelope.errors[0].message}`;
  } else if (failedSources.length > 0 && results.length > 0) {
    text += `\n\nFailed sources: ${failedSources.join(', ')}.`;
  }

  return northstarTextResult(text, { query, source, results }, envelope);
}

async function github(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  // Thin delegation: validation, REST, and normalization live in github-domain.
  return callGithubTool(args, {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

const KG_ACTIONS: readonly string[] = ['search', 'enhance', 'analyze_text'];

function kgString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toKgSourceOutcome(outcome: DiffbotKgOutcome): KgSourceOutcome {
  if (!outcome.error) return { provider: outcome.provider, entities: outcome.entities, invalid: outcome.invalid };
  const { code, message, retryable } = outcome.error;
  return { provider: outcome.provider, entities: outcome.entities, invalid: outcome.invalid, error: { code, message, retryable } };
}

/** Enhance outcomes keep provider-normalized claims/evidence/signals for assembly; envelope ignores the extras. */
interface KgEnhanceSourceOutcome extends KgSourceOutcome {
  claims?: KgClaim[];
  evidence?: KgEntityEvidence[];
  signals?: KgIdentitySignals[];
}

function toKgEnhanceOutcome(outcome: DiffbotKgOutcome): KgEnhanceSourceOutcome {
  const base = toKgSourceOutcome(outcome);
  return {
    ...base,
    ...(outcome.claims !== undefined ? { claims: outcome.claims } : {}),
    ...(outcome.evidence !== undefined ? { evidence: outcome.evidence } : {}),
    ...(outcome.signals !== undefined ? { signals: outcome.signals } : {}),
  };
}

function unsupportedKgOutcome(provider: string, message: string): KgSourceOutcome {
  return { provider, error: { code: 'unsupported_option', message, retryable: false } };
}

function partitionForOutcome(outcome: KgSourceOutcome): KgPartition {
  const count = outcome.entities?.length ?? 0;
  // Mirror buildKnowledgeResult sources rows: dropped invalid rows fail the
  // partition (partial when entities survive, error otherwise). Provider
  // errors keep the existing terminal 'error' status.
  if (outcome.error !== undefined) {
    return {
      provider: outcome.provider,
      status: 'error',
      error: { ...outcome.error, provider: outcome.provider } as KgError,
    };
  }
  if ((outcome.invalid ?? 0) > 0) {
    return { provider: outcome.provider, status: count > 0 ? 'partial' : 'error' };
  }
  return { provider: outcome.provider, status: count > 0 ? 'ok' : 'empty' };
}

function kgEntitiesText(entities: ReadonlyArray<KgEntity>): string {
  return entities
    .map((entity, index) => `## ${index + 1}. ${entity.name ?? entity.id}\n${entity.url ?? entity.id}\ntype: ${entity.type}`)
    .join('\n\n');
}

function kgResultText(action: KgAction, label: string, entities: ReadonlyArray<KgEntity>, errors: ReadonlyArray<KgError>): string {
  if (entities.length > 0) return kgEntitiesText(entities);
  if (errors.length > 0 && errors[0]) return `Kg ${action} error (${errors[0].provider ?? 'kg'}): ${errors[0].message}`;
  return `No kg ${action} results for: ${label}`;
}

// Email/phone enhance selectors are PII: never echo them into user-facing
// tool text. Name/id/url labels pass through verbatim (phone-digit redaction
// would mangle ids/urls); only an embedded email is scrubbed there.
function redactKgSelectorLabel(label: string, fromSensitiveSelector: boolean): string {
  const noEmail = label.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  if (!fromSensitiveSelector) return noEmail;
  return noEmail.replace(/\+?\d[\d\s().-]{6,}\d/g, '[REDACTED_PHONE]');
}

interface KgRouting {
  outcomes: KgSourceOutcome[];
  providers: string[];
  attempted: string[];
}

async function routeKg(
  action: KgAction,
  requested: readonly string[] | undefined,
  configured: string[],
  maxProviders: number | undefined,
  execute: (provider: string) => Promise<KgSourceOutcome>,
): Promise<KgRouting> {
  if (requested !== undefined) {
    const plan = planExplicitProviders(action, requested, {
      configured,
      ...(maxProviders !== undefined ? { maxProviders } : {}),
    });
    const ran = await runKgFanout(execute, plan.runnable);
    const outcomes = [...ran, ...plan.unsupported.map((error) => unsupportedKgOutcome(error.provider ?? 'unknown', error.message))];
    return { outcomes, providers: [...requested], attempted: [...plan.runnable] };
  }
  const ordered = selectAutoProviders(action, configured);
  const { outcome, attempted } = await runKgAuto(execute, ordered);
  return { outcomes: [outcome], providers: [...attempted], attempted };
}

async function kg(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'search';
  if (!KG_ACTIONS.includes(action)) {
    throw new Error(`Native kg only supports search, enhance and analyze_text actions, got: ${action}`);
  }
  const env = options.env ?? process.env;
  // Spend resolved once per call: invalid operator config rejects before any paid call.
  const spend = resolveKgSpend(env);
  const token = env.DIFFBOT_TOKEN?.trim() ?? '';
  const configured = token ? [DIFFBOT_KG_PROVIDER as string] : [];
  const requested = Array.isArray(args.providers)
    ? (args.providers as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const cursor = kgString(args.cursor);
  rejectCursorForExplicitFanout(cursor, requested);
  // Operator cap wins: omitted maxProviders uses the configured default;
  // public/request values above it reject instead of clamping or partitioning excess.
  const publicMaxProviders = typeof args.maxProviders === 'number' ? args.maxProviders : undefined;
  if (publicMaxProviders !== undefined) {
    if (!Number.isInteger(publicMaxProviders) || publicMaxProviders < 1 || publicMaxProviders > KG_MAX_PROVIDERS_CEILING) {
      throw new KgContractError(
        'unsupported_option',
        `maxProviders out of range: expected integer 1..${KG_MAX_PROVIDERS_CEILING}`,
      );
    }
    if (publicMaxProviders > spend.maxProviders) {
      throw new KgContractError(
        'invalid_input',
        `maxProviders ${publicMaxProviders} exceeds operator cap ${spend.maxProviders}`,
      );
    }
  }
  const maxProviders = publicMaxProviders ?? spend.maxProviders;
  if (requested !== undefined && new Set(requested).size > maxProviders) {
    throw new KgContractError(
      'invalid_input',
      `${new Set(requested).size} providers requested exceeds maxProviders cap ${maxProviders}`,
    );
  }
  const ctx: { token: string; signal?: AbortSignal; spend: DiffbotKgSpend } = {
    token,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    spend: {
      searchDefault: spend.searchSize,
      searchCap: spend.searchSize,
      enhanceDefault: spend.enhanceSize,
      enhanceCap: spend.enhanceSize,
      nlpMaxChars: spend.nlpMaxChars,
    },
  };
  if (action === 'search') return kgSearch(args, { env, ctx, spend, configured, requested, cursor, maxProviders });
  if (action === 'enhance') return kgEnhance(args, { env, ctx, spend, configured, requested, maxProviders });
  return kgAnalyzeText(args, { env, ctx, spend, configured, requested, maxProviders });
}

interface KgCallContext {
  env: Record<string, string | undefined>;
  ctx: { token: string; signal?: AbortSignal; spend: DiffbotKgSpend };
  spend: DiffbotSpend;
  configured: string[];
  requested: string[] | undefined;
  cursor?: string | undefined;
  maxProviders: number;
}

/** Resolve DIFFBOT_* spend once; invalid config becomes a contract rejection, never a paid call. */
function resolveKgSpend(env: Record<string, string | undefined>): DiffbotSpend {
  try {
    return resolveDiffbotSpend(env);
  } catch (error) {
    if (error instanceof DiffbotError) throw new KgContractError('unsupported_option', error.message);
    throw error;
  }
}

function throwKgContract(code: KgError['code'], message: string): never {
  throw new KgContractError(code, message);
}

async function kgSearch(args: Record<string, unknown>, call: KgCallContext): Promise<BackendCallResult> {
  const validated = validateKgSearch({ query: args.query, language: args.language ?? 'dql', limit: args.limit });
  if (!validated.ok) throwKgContract(validated.code, validated.message);
  const query = (validated as { query: string }).query;
  const limit = (validated as { limit?: number }).limit;
  // Omitted limit uses the operator-configured search default; the adapter
  // rejects explicit values above the operator cap without a paid call.
  const pageSize = limit ?? call.spend.searchSize;
  const fingerprint = fingerprintKgRequest({ action: 'search', query, limit: pageSize, providers: call.requested ?? 'auto' });
  let from = 0;
  if (call.cursor !== undefined && call.requested === undefined) {
    const ordered = selectAutoProviders('search', call.configured);
    const pinned = decodePinnedKgCursor(call.cursor, {
      provider: ordered[0] ?? DIFFBOT_KG_PROVIDER,
      fingerprint,
      adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V,
    });
    const rawFrom = pinned.state['from'];
    if (typeof rawFrom !== 'number' || !Number.isInteger(rawFrom) || rawFrom < 0) {
      throw new KgContractError('cursor_invalid', 'Cursor state.from must be an integer >= 0.');
    }
    if (rawFrom > DIFFBOT_KG_MAX_FROM || rawFrom + pageSize > DIFFBOT_KG_MAX_FROM) {
      throw new KgContractError(
        'cursor_invalid',
        `Cursor state.from out of range: must satisfy from <= ${DIFFBOT_KG_MAX_FROM} and from+size <= ${DIFFBOT_KG_MAX_FROM}.`,
      );
    }
    from = rawFrom;
  }
  const { outcomes, providers } = await routeKg('search', call.requested, call.configured, call.maxProviders, async (provider) => {
    if (provider !== DIFFBOT_KG_PROVIDER) return unsupportedKgOutcome(provider, `Unknown kg provider: ${provider}.`);
    return toKgSourceOutcome(await searchDiffbotKg({ query, language: 'dql', limit: pageSize, from }, call.ctx));
  });
  const rawEntities = outcomes.flatMap((outcome) => (outcome.entities ? [...outcome.entities] : []));
  // Every provider ranking aggregates through RRF (identity-aware fusion,
  // first copy kept); a single ranking keeps fetch order by construction.
  const entities = rrfRankKgEntities(
    outcomes.map((outcome) => (outcome.entities ? [...outcome.entities] : [])),
  ).map((entry) => entry.item);
  // Single-provider auto mode pages by offset; explicit fanout is one bounded page.
  const single = call.requested === undefined && outcomes.length === 1 && outcomes[0] !== undefined;
  const hasMore = single && rawEntities.length >= pageSize && pageSize > 0 && from + pageSize < DIFFBOT_KG_MAX_FROM;
  const nextCursor = single && hasMore && outcomes[0]
    ? issueKgCursor({
      provider: outcomes[0].provider,
      fingerprint,
      adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V,
      state: { from: from + pageSize },
      fanout: false,
    })
    : undefined;
  const envelope = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search', providers },
    outcomes,
    data: { kind: 'search', entities },
    pagination: {
      supported: single,
      limit: pageSize,
      ...(nextCursor !== undefined ? { hasMore: true as const, nextCursor } : { hasMore: false as const }),
    },
  });
  const text = kgResultText('search', query, entities, envelope.errors);
  return textResult(wrapUntrustedText(text, { source: 'kg' }), { action: 'search', query, providers, knowledge: envelope });
}

const KG_ENHANCE_PASSTHROUGH = [
  'id', 'name', 'url', 'email', 'phone', 'location', 'description',
  'employer', 'title', 'school', 'fields', 'maxEntities',
  'includeRelationships', 'includeEvidence', 'confidenceThreshold',
] as const;

async function kgEnhance(args: Record<string, unknown>, call: KgCallContext): Promise<BackendCallResult> {
  const input: Record<string, unknown> = { type: args.type };
  for (const key of KG_ENHANCE_PASSTHROUGH) {
    if (args[key] !== undefined) input[key] = args[key];
  }
  const validated = validateKgEnhance(input);
  if (!validated.ok) throwKgContract(validated.code, validated.message);
  const { outcomes, providers } = await routeKg('enhance', call.requested, call.configured, call.maxProviders, async (provider) => {
    if (provider !== DIFFBOT_KG_PROVIDER) return unsupportedKgOutcome(provider, `Unknown kg provider: ${provider}.`);
    return toKgEnhanceOutcome(await enhanceDiffbotKg(input, call.ctx));
  });
  const enhanceOutcomes = outcomes as KgEnhanceSourceOutcome[];
  const inputs = enhanceOutcomes.flatMap((outcome) =>
    (outcome.entities ?? []).map((entity, index) => ({
      entity,
      provider: outcome.provider,
      ...(outcome.signals?.[index] !== undefined ? { signals: outcome.signals[index] as KgIdentitySignals } : {}),
    })),
  );
  const entities = dedupeKgEntities(inputs).map((member) => member.entity);
  // Conservative alignment: members grouped without adjudication; public
  // records carry basis/strength only (alignment confidence never computed).
  // Internal identity keys stay private: public groups use opaque
  // response-local deterministic-by-order ids (alignment:1, ...).
  const internalGroups = groupKgEntitiesByIdentity(inputs);
  const publicIdByKey = new Map<string, string>();
  internalGroups.forEach((group, index) => {
    publicIdByKey.set(group.key, `alignment:${index + 1}`);
  });
  const groups: KgAlignedGroup[] = internalGroups.map((group) => ({
    id: publicIdByKey.get(group.key) ?? 'alignment:0',
    basis: group.basis,
    strength: group.strength,
    ...(group.alignmentConfidence !== undefined ? { alignmentConfidence: group.alignmentConfidence } : {}),
    members: group.members.map((member) => ({ entity: member.entity, provider: member.provider })),
  }));
  // Provider-normalized claims keep trace tags; partition surfaces real
  // conflicts while preserving every input row. Partitions mirror outcomes.
  const allClaims: KgClaim[] = enhanceOutcomes.flatMap((outcome) =>
    (outcome.claims ?? []).map((claim) =>
      claim.provider === undefined ? { ...claim, provider: outcome.provider } : claim,
    ),
  );
  // Aligned subjects share one partition key: remap each claim's raw
  // provider-native subjectId to its opaque public group id so cross-row
  // conflicts (e.g. same canonical_url, different diffbotUri) compare.
  const subjectToGroup = new Map<string, string>();
  for (const group of internalGroups) {
    const publicId = publicIdByKey.get(group.key) ?? 'alignment:0';
    for (const member of group.members) {
      if (!subjectToGroup.has(member.entity.id)) subjectToGroup.set(member.entity.id, publicId);
    }
  }
  const alignedClaims: KgClaim[] = allClaims.map((claim) => {
    const key = subjectToGroup.get(claim.subjectId);
    return key !== undefined && key !== claim.subjectId ? { ...claim, subjectId: key } : claim;
  });
  const { claims, conflicts } = partitionEnhanceClaims(alignedClaims);
  const seenEvidence = new Set<string>();
  const evidence: KgEntityEvidence[] = [];
  for (const outcome of enhanceOutcomes) {
    for (const record of outcome.evidence ?? []) {
      if (seenEvidence.has(record.entityId)) continue;
      seenEvidence.add(record.entityId);
      evidence.push(record);
    }
  }
  const partitions = outcomes.map(partitionForOutcome);
  const envelope = buildKnowledgeResult({
    request: { tool: 'kg', action: 'enhance', providers },
    outcomes,
    data: { kind: 'enhance', entities, claims, conflicts, partitions, groups, evidence },
  });
  const emailSelector = kgString(args.email);
  const phoneSelector = emailSelector === undefined ? kgString(args.phone) : undefined;
  const rawLabel = kgString(args.name) ?? kgString(args.id) ?? kgString(args.url) ?? emailSelector ?? phoneSelector ?? 'selectors';
  const label = redactKgSelectorLabel(rawLabel, rawLabel === emailSelector || rawLabel === phoneSelector);
  const text = kgResultText('enhance', label, entities, envelope.errors);
  return textResult(wrapUntrustedText(text, { source: 'kg' }), { action: 'enhance', providers, knowledge: envelope });
}

async function kgAnalyzeText(args: Record<string, unknown>, call: KgCallContext): Promise<BackendCallResult> {
  const validated = validateKgNlp({
    text: args.text,
    ...(args.extractEntities !== undefined ? { extractEntities: args.extractEntities } : {}),
    ...(args.extractFacts !== undefined ? { extractFacts: args.extractFacts } : {}),
    ...(args.extractSentiment !== undefined ? { extractSentiment: args.extractSentiment } : {}),
    ...(args.extractTopics !== undefined ? { extractTopics: args.extractTopics } : {}),
    ...(args.language !== undefined ? { language: args.language } : {}),
  });
  if (!validated.ok) throwKgContract(validated.code, validated.message);
  const nlp = validated as { text: string };
  const nlpOutcomes: DiffbotNlpOutcome[] = [];
  const { outcomes, providers } = await routeKg('analyze_text', call.requested, call.configured, call.maxProviders, async (provider) => {
    if (provider !== DIFFBOT_KG_PROVIDER) return unsupportedKgOutcome(provider, `Unknown kg provider: ${provider}.`);
    const outcome = await analyzeTextDiffbotKg({ text: nlp.text, ...pickNlpFlags(args) }, call.ctx);
    nlpOutcomes.push(outcome);
    return toKgSourceOutcome(outcome);
  });
  const partitions = outcomes.map(partitionForOutcome);
  const aggregated = aggregateKgTextAnalysis({
    text: nlp.text,
    entities: outcomes.flatMap((outcome) => (outcome.entities ? [...outcome.entities] : [])),
    mentions: nlpOutcomes.flatMap((outcome) => outcome.mentions),
    facts: nlpOutcomes.flatMap((outcome) => outcome.facts),
    topics: nlpOutcomes.flatMap((outcome) => outcome.topics),
    sentiments: nlpOutcomes.map((outcome) => outcome.sentiment).filter((entry): entry is string => typeof entry === 'string'),
    partitions,
  });
  const envelope = buildKnowledgeResult({
    request: { tool: 'kg', action: 'analyze_text', providers },
    outcomes,
    data: {
      kind: 'analyze_text',
      entities: aggregated.entities,
      mentions: aggregated.mentions,
      facts: aggregated.facts,
      topics: aggregated.topics,
      ...(aggregated.sentiment !== undefined ? { sentiment: aggregated.sentiment } : {}),
      partitions: aggregated.partitions,
    },
  });
  const text = kgResultText('analyze_text', `${nlp.text.length} chars`, aggregated.entities, envelope.errors);
  return textResult(wrapUntrustedText(text, { source: 'kg' }), { action: 'analyze_text', providers, knowledge: envelope });
}

function pickNlpFlags(args: Record<string, unknown>): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const key of ['extractEntities', 'extractFacts', 'extractSentiment', 'extractTopics', 'language'] as const) {
    if (args[key] !== undefined) flags[key] = args[key];
  }
  return flags;
}
