// SearXNG web-search adapter (canonical WebSearchAdapter shape).
// Exact behavior extraction from the legacy inline adapter in src/web.ts:
// GET {operator base}/search with q + format=json + safesearch=1,
// {results:[{title,url,content}]} mapping. One request, no retry.
// The base URL is operator-owned (may be loopback), so the operator-owned
// unsafeFetchJson path is used — no public-URL validation, matching the source.

import { unsafeFetchJson } from './http.js';
import type {
  WebProviderSearchInput,
  WebProviderSearchOutput,
  WebSearchAdapter,
  WebSearchHit,
} from './web-search-types.js';

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export const searxngSearchAdapter: WebSearchAdapter = {
  id: 'searxng',
  configured(env: Record<string, string | undefined>): boolean {
    return Boolean(env.SEARXNG_BASE_URL?.trim());
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const baseUrl = input.env.SEARXNG_BASE_URL?.trim();
    if (!baseUrl) return { backend: 'searxng', hits: [], generatedText: [] };
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/search`);
    url.searchParams.set('q', input.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '1');
    const data = (await unsafeFetchJson(url.href, { Accept: 'application/json' }, input.signal)) as {
      results?: Array<Record<string, unknown>>;
    };
    const hits: WebSearchHit[] = (data.results ?? [])
      .slice(0, input.limit)
      .map((result) => ({
        title: stringField(result.title, 'Untitled'),
        url: stringField(result.url, ''),
        snippet: stringField(result.content, ''),
        backend: 'searxng' as const,
      }))
      .filter((hit) => hit.url);
    return { backend: 'searxng', hits, generatedText: [] };
  },
};
