// SerpApi web-search adapter (canonical WebSearchAdapter shape).
// Exact vendor behavior from pinned reference nicobailon/pi-web-access@192ac18
// (serpapi.ts): GET https://serpapi.com/search.json with engine=google, q, num,
// api_key in query (vendor-required, never moved to a header), tbs qdr map,
// site: query rewrite for domain filters, hostname post-filter, +5 headroom.
// Response {organic_results:[{link,title,snippet}]}; 200 error envelope is
// invalid_response. One request, no retry. Env-only credentials.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const SERPAPI_SEARCH_ENDPOINT = 'https://serpapi.com/search.json';
export const SERPAPI_SEARCH_RESULT_MAX = 20;
const SERPAPI_TITLE_MAX_CHARS = 500;

const SERPAPI_QDR_TBS = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
} as const;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

import { buildQuery, parseDomainFilter, passesDomainFilters } from './web-site-filter.js';

/** Strip key material and the keyed request URL so errors stay safe. */
function scrubMessage(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(/api_key=[^&\s]*/g, 'api_key=[REDACTED]');
}

function errorText(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubMessage(message, secrets);
}

export const serpapiSearchAdapter: WebSearchAdapter = {
  id: 'serpapi',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.SERPAPI_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.SERPAPI_KEY?.trim();
    if (!apiKey) return { backend: 'serpapi', hits: [], generatedText: [] };
    const numResults = Math.min(Math.max(Math.floor(input.limit), 1), SERPAPI_SEARCH_RESULT_MAX);
    const filters = parseDomainFilter(input.domains);
    const requestCount = input.domains?.length ? Math.min(SERPAPI_SEARCH_RESULT_MAX, numResults + 5) : numResults;
    // Key stays in the query string (vendor-required). The keyed URL is only
    // ever passed to fetch; every error below is scrubbed of it.
    const url = new URL(SERPAPI_SEARCH_ENDPOINT);
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', buildQuery(input.query, filters));
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('num', String(requestCount));
    const tbs = input.recency ? SERPAPI_QDR_TBS[input.recency] : undefined;
    if (tbs) url.searchParams.set('tbs', tbs);
    const requestUrl = url.toString();
    const secrets = [apiKey, requestUrl];
    const validated = fetchInit({ Accept: 'application/json' }, undefined);
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        ...validated,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        redirect: 'manual',
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new Error(`SerpApi search request failed: ${errorText(error, secrets).slice(0, 300)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for serpapi search');
    }
    if (!response.ok) throw new Error(`SerpApi search failed with HTTP ${response.status}`);
    let data: unknown;
    try {
      data = await safeResponseJson(response, SERPAPI_SEARCH_ENDPOINT);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new Error(`SerpApi search returned an invalid response: ${errorText(error, secrets).slice(0, 300)}`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('SerpApi returned an invalid response: expected object envelope');
    }
    const envelope = data as Record<string, unknown>;
    if (typeof envelope.error === 'string' && envelope.error.trim()) {
      throw new Error(
        `SerpApi returned an invalid response: ${scrubMessage(envelope.error.trim(), [apiKey]).slice(0, 300)}`,
      );
    }
    if (!Array.isArray(envelope.organic_results)) {
      throw new Error('SerpApi returned an invalid response: expected organic_results array');
    }
    const hits: WebSearchHit[] = [];
    for (const row of envelope.organic_results) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const urlValue = typeof record.link === 'string' ? record.link.trim() : '';
      if (!urlValue || !isHttpUrl(urlValue) || !passesDomainFilters(urlValue, filters)) continue;
      const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
      const snippetRaw = typeof record.snippet === 'string' ? record.snippet.replace(/\s+/g, ' ').trim() : '';
      hits.push({
        title: (titleRaw || 'Untitled').slice(0, SERPAPI_TITLE_MAX_CHARS),
        url: urlValue,
        snippet: snippetRaw.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'serpapi',
      });
      if (hits.length >= numResults) break;
    }
    return { backend: 'serpapi', hits, generatedText: [] };
  },
};
