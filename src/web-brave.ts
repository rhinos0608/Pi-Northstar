// Brave web-search adapter (canonical WebSearchAdapter shape).
// Exact behavior extraction from the legacy inline adapter in src/web.ts:
// GET fixed vendor endpoint with q + count (capped at 20), X-Subscription-Token
// auth, {web:{results:[{title,url,description}]}} mapping. One request, no retry.
// Direct env credentials only; failures never carry the key.

import { fetchInit, safeResponseJson } from './http.js';
import type {
  WebProviderSearchInput,
  WebProviderSearchOutput,
  WebSearchAdapter,
  WebSearchHit,
} from './web-search-types.js';

export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_SEARCH_RESULT_MAX = 20;

const BRAVE_FRESHNESS: Record<'day' | 'week' | 'month' | 'year', string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

function bravePublishedDateOf(result: Record<string, unknown>): string | undefined {
  for (const key of ['page_age', 'date'] as const) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

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
    // Lower-bound pushdown: an explicit bound (recency+yearFrom intersect,
    // coordinator-owned) maps to Brave's custom date range; bare recency maps
    // to Brave's relative windows. Range form covers yearFrom-only requests
    // that no relative window can express.
    if (input.freshnessLowerBoundMs !== undefined && Number.isFinite(input.freshnessLowerBoundMs)) {
      const start = new Date(input.freshnessLowerBoundMs).toISOString().slice(0, 10);
      const end = new Date(Date.now()).toISOString().slice(0, 10);
      url.searchParams.set('freshness', `${start}to${end}`);
    } else if (input.recency !== undefined) {
      url.searchParams.set('freshness', BRAVE_FRESHNESS[input.recency]);
    }
    // Credential-routing control: the vendor key must never ride a redirect off
    // the fixed host, so redirects reject instead of being followed (Exa/Tavily
    // pattern). No response.ok gate: error envelopes resolve to empty hits.
    const validated = fetchInit(
      { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      input.signal,
    );
    const response = await fetch(url.href, { ...validated, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for brave search');
    }
    const data = (await safeResponseJson(response, url.href)) as {
      web?: { results?: Array<Record<string, unknown>> };
    };
    const hits: WebSearchHit[] = (data.web?.results ?? [])
      .slice(0, input.limit)
      .map((result) => {
        const publishedDate = bravePublishedDateOf(result);
        return {
          title: stringField(result.title, 'Untitled'),
          url: stringField(result.url, ''),
          snippet: stringField(result.description, ''),
          backend: 'brave' as const,
          ...(publishedDate !== undefined ? { publishedDate } : {}),
        };
      })
      .filter((hit) => hit.url);
    return { backend: 'brave', hits, generatedText: [] };
  },
};
