// Provider-neutral sitemap registry for fetch({ siteMap: true }).
// First provider is Tavily Map (POST /map). Future sitemap-capable
// providers append to SITEMAP_PROVIDERS; callers never see provider
// specifics. Safe fixed provider settings only: same-origin results,
// allow_external:false, limit = validated maxPages. No token, raw
// response, request_id, or usage ever echoes into errors.

import { fetchInit, safeResponseJson, validateHttpUrl } from './http.js';
import { type DnsLookup, resolvePublicHostname } from './network-policy.js';
import { BM25Index } from './bm25.js';
import { EmbeddingClient } from './embedding-client.js';
import { rrfMerge } from './fusion.js';
import { acquireEmbeddingSidecar, type AcquiredSidecar } from './shared-sidecar.js';
import { VectorIndex } from './vector-index.js';

export const TAVILY_MAP_ENDPOINT = 'https://api.tavily.com/map';
/** Bounded fixed provider timeout: Tavily Map may run up to 150s. */
export const TAVILY_MAP_TIMEOUT_MS = 150_000;
export const TAVILY_MAP_TIMEOUT_SECONDS = 150;

export type SitemapProviderId = 'tavily';

export interface SitemapMapInput {
  rootUrl: string;
  maxPages: number;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  lookup?: DnsLookup;
}

export interface SitemapMapResult {
  provider: SitemapProviderId;
  baseUrl: string;
  urls: string[];
}

export interface SitemapProvider {
  readonly id: SitemapProviderId;
  configured(env: Record<string, string | undefined>): boolean;
  map(input: SitemapMapInput): Promise<SitemapMapResult>;
}

/** Normalize provider URL rows: http(s) only, same origin as root, deduped, capped. */
function normalizeMapUrls(raw: unknown, rootOrigin: string, maxPages: number): string[] {
  if (!Array.isArray(raw)) throw new Error('Tavily map returned an invalid response');
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const row of raw) {
    if (urls.length >= maxPages) break;
    if (typeof row !== 'string') continue;
    const value = row.trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (parsed.origin !== rootOrigin) continue;
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    urls.push(parsed.href);
  }
  return urls;
}

export async function mapTavilySite(
  rootUrl: string,
  maxPages: number,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  lookup?: DnsLookup,
): Promise<SitemapMapResult> {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) throw new Error('Tavily map is not configured');
  // Root validation owns literal SSRF policy (private/reserved/metadata/
  // credentials reject here); DNS preflight rejects private DNS answers
  // before any provider dispatch. Result rows re-check against this origin.
  const validatedRoot = validateHttpUrl(rootUrl);
  const rootOrigin = new URL(validatedRoot).origin;
  await resolvePublicHostname(new URL(validatedRoot).hostname, signal, lookup);
  const validated = fetchInit(
    { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    undefined,
    TAVILY_MAP_TIMEOUT_MS,
  );
  const response = await fetch(TAVILY_MAP_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ url: validatedRoot, allow_external: false, limit: maxPages, timeout: TAVILY_MAP_TIMEOUT_SECONDS }),
    ...validated,
    ...(signal !== undefined ? { signal } : {}),
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Redirect rejected for tavily map');
  }
  if (!response.ok) throw new Error(`Tavily map failed with HTTP ${response.status}`);
  const data = (await safeResponseJson(response, TAVILY_MAP_ENDPOINT)) as Record<string, unknown>;
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.results)) {
    throw new Error('Tavily map returned an invalid response');
  }
  // Never echo provider-supplied base_url: canonical validated origin only.
  return { provider: 'tavily', baseUrl: rootOrigin, urls: normalizeMapUrls(data.results, rootOrigin, maxPages) };
}

export const tavilySitemapProvider: SitemapProvider = {
  id: 'tavily',
  configured(env): boolean {
    return (env.TAVILY_API_KEY?.trim().length ?? 0) > 0;
  },
  async map(input): Promise<SitemapMapResult> {
    return mapTavilySite(input.rootUrl, input.maxPages, input.env, input.signal, input.lookup);
  },
};

/** Sitemap-capable providers in preference order. Tavily first. */
export const SITEMAP_PROVIDERS: readonly SitemapProvider[] = [tavilySitemapProvider];

export function resolveSitemapProvider(env: Record<string, string | undefined>): SitemapProvider {
  for (const provider of SITEMAP_PROVIDERS) {
    if (provider.configured(env)) return provider;
  }
  throw new Error('No sitemap-capable fetch providers configured');
}

export const DEFAULT_SITEMAP_MAX_PAGES = 10;
export const SITEMAP_MAX_PAGES_MAX = 25;

export type SitemapRanking = 'provider' | 'bm25' | 'bm25+embedding+rrf';

export interface SitemapResult extends SitemapMapResult {
  urls: string[];
  ranking: SitemapRanking;
}

export interface RunSitemapOptions {
  query?: string;
  maxPages?: number;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  lookup?: DnsLookup;
}

/** Readable document text for a URL-only entry: host plus path words. No page fetch. */
function urlDocumentText(url: string): string {
  try {
    const parsed = new URL(url);
    const words = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`
      .split(/[^a-zA-Z0-9]+/)
      .filter((part) => part.length > 0)
      .join(' ');
    return words.length > 0 ? words : url;
  } catch {
    return url;
  }
}

function embeddingEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.PI_SEARCH_EMBEDDING_ENABLED;
  if (value === undefined) return true;
  return value !== '0' && value !== 'false';
}

/**
 * Rank discovered URLs against the optional query using the repository
 * embedding/ranking infrastructure: BM25 over URL-derived text plus the
 * embedding sidecar hybrid when available, BM25-only fallback otherwise.
 * URL strings only — mapped pages are never fetched. Returns provider order
 * and 'provider' when no query is given.
 */
async function rankSitemapUrls(
  urls: string[],
  query: string | undefined,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ urls: string[]; ranking: SitemapRanking }> {
  if (query === undefined || urls.length === 0) return { urls, ranking: 'provider' };
  const index = new BM25Index();
  const docs = urls.map((url, position) => ({ id: String(position), url, text: urlDocumentText(url) }));
  for (const doc of docs) index.add(doc.id, doc.text);
  const byId = new Map(docs.map((doc) => [doc.id, doc.url] as const));
  // Ranked matches first; unmatched URLs keep provider order appended so
  // ranking orders but never drops mapped results.
  const withUnmatched = (ranked: string[]): string[] => {
    const seen = new Set(ranked);
    return [...ranked, ...urls.filter((url) => !seen.has(url))];
  };
  if (!embeddingEnabled(env)) {
    return {
      urls: withUnmatched(index.search(query, urls.length).map((hit) => byId.get(hit.id)!)),
      ranking: 'bm25',
    };
  }
  // Shared persistent sidecar: released (not stopped) so the Python process
  // is reused across calls. External EMBEDDING_SIDECAR_BASE_URL bypasses
  // the local lifecycle.
  let acquired: AcquiredSidecar | undefined;
  try {
    signal?.throwIfAborted();
    acquired = await acquireEmbeddingSidecar(env);
    signal?.throwIfAborted();
    const embeddingClient = new EmbeddingClient({
      baseUrl: acquired.baseUrl,
      ...(signal !== undefined ? { signal } : {}),
    });
    // External sidecars are caller-managed — verify reachability; the local
    // singleton is already health-poll verified by ensureRunning.
    if (acquired.external) await embeddingClient.health();
    const vectorIndex = new VectorIndex();
    const vectors = await embeddingClient.embedBatch(docs.map((doc) => doc.text));
    signal?.throwIfAborted();
    for (let i = 0; i < docs.length; i++) vectorIndex.add(docs[i]!.id, vectors[i]!);
    const queryVec = await embeddingClient.embed(query);
    signal?.throwIfAborted();
    const fused = rrfMerge(
      [
        index.search(query, urls.length).map((hit) => ({ id: hit.id, score: hit.score })),
        vectorIndex.search(queryVec, urls.length).map((hit) => ({ id: hit.id, score: hit.score })),
      ],
      { keyFn: (item: { id: string }) => item.id },
    );
    acquired?.release();
    return { urls: withUnmatched(fused.map((entry) => byId.get(entry.item.id)!)), ranking: 'bm25+embedding+rrf' };
  } catch (error) {
    // Caller abort always propagates; embedding failures fall back to BM25.
    // The ranking field exposes the fallback — no error text is logged.
    acquired?.release();
    if ((error as { name?: unknown })?.name === 'AbortError' || signal?.aborted) throw error;
    return {
      urls: withUnmatched(index.search(query, urls.length).map((hit) => byId.get(hit.id)!)),
      ranking: 'bm25',
    };
  }
}

/**
 * Map a root URL into a capped, optionally query-ranked URL list.
 * maxPages defaults to 10, caps at 25 (fetch-path conventions);
 * out-of-range rejects before any provider call.
 */
export async function runSitemap(rootUrl: string, options: RunSitemapOptions): Promise<SitemapResult> {
  const maxPages = options.maxPages ?? DEFAULT_SITEMAP_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > SITEMAP_MAX_PAGES_MAX) {
    throw new Error(`maxPages must be an integer in [1, ${SITEMAP_MAX_PAGES_MAX}]`);
  }
  const query = typeof options.query === 'string' && options.query.trim().length > 0 ? options.query.trim() : undefined;
  if (options.query !== undefined && typeof options.query !== 'string') {
    throw new Error('query must be a string');
  }
  const provider = resolveSitemapProvider(options.env);
  const mapped = await provider.map({
    rootUrl,
    maxPages,
    env: options.env,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
  });
  const ranked = await rankSitemapUrls(mapped.urls, query, options.env, options.signal);
  return { provider: mapped.provider, baseUrl: mapped.baseUrl, urls: ranked.urls, ranking: ranked.ranking };
}
