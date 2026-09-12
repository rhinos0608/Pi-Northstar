// Brave web-search adapter (canonical WebSearchAdapter shape).
// Exact behavior extraction from the legacy inline adapter in src/web.ts:
// GET fixed vendor endpoint with q + count (capped at 20), X-Subscription-Token
// auth, {web:{results:[{title,url,description}]}} mapping. One request, no retry.
// Direct env credentials only; failures never carry the key.

import { fetchJson } from './http.js';
import type {
  WebProviderSearchInput,
  WebProviderSearchOutput,
  WebSearchAdapter,
  WebSearchHit,
} from './web-search-types.js';

export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_SEARCH_RESULT_MAX = 20;

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export const braveSearchAdapter: WebSearchAdapter = {
  id: 'brave',
  configured(env: Record<string, string | undefined>): boolean {
    return Boolean(env.BRAVE_API_KEY?.trim());
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.BRAVE_API_KEY?.trim();
    if (!apiKey) return { backend: 'brave', hits: [], generatedText: [] };
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(Math.min(input.limit, BRAVE_SEARCH_RESULT_MAX)));
    const data = (await fetchJson(
      url.href,
      { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      input.signal,
    )) as { web?: { results?: Array<Record<string, unknown>> } };
    const hits: WebSearchHit[] = (data.web?.results ?? [])
      .slice(0, input.limit)
      .map((result) => ({
        title: stringField(result.title, 'Untitled'),
        url: stringField(result.url, ''),
        snippet: stringField(result.description, ''),
        backend: 'brave' as const,
      }))
      .filter((hit) => hit.url);
    return { backend: 'brave', hits, generatedText: [] };
  },
};
