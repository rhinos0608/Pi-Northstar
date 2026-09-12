// Serper web-search adapter (canonical WebSearchAdapter shape).
// Exact vendor behavior from pinned reference nicobailon/pi-web-access@192ac18
// (serper.ts): POST https://google.serper.dev/search, X-API-KEY header,
// {q, num, tbs? qdr map}, site: query rewrite for domain filters, hostname
// post-filter, +5 headroom. Response {organic:[{link,title,snippet}]}.
// Depth 11-20 is retained (costs two credits upstream). One request, no retry.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const SERPER_SEARCH_ENDPOINT = 'https://google.serper.dev/search';
export const SERPER_SEARCH_RESULT_MAX = 20;
const SERPER_TITLE_MAX_CHARS = 500;

const SERPER_QDR_TBS = {
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

function errorText(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.split(apiKey).join('[REDACTED]') : message;
}

export const serperSearchAdapter: WebSearchAdapter = {
  id: 'serper',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.SERPER_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.SERPER_API_KEY?.trim();
    if (!apiKey) return { backend: 'serper', hits: [], generatedText: [] };
    const numResults = Math.min(Math.max(Math.floor(input.limit), 1), SERPER_SEARCH_RESULT_MAX);
    const filters = parseDomainFilter(input.domains);
    const requestCount = input.domains?.length ? Math.min(SERPER_SEARCH_RESULT_MAX, numResults + 5) : numResults;
    const tbs = input.recency ? SERPER_QDR_TBS[input.recency] : undefined;
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      undefined,
    );
    let response: Response;
    try {
      response = await fetch(SERPER_SEARCH_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({
          q: buildQuery(input.query, filters),
          num: requestCount,
          ...(tbs ? { tbs } : {}),
        }),
        ...validated,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        redirect: 'manual',
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new Error(`Serper search request failed: ${errorText(error, apiKey).slice(0, 300)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for serper search');
    }
    if (!response.ok) throw new Error(`Serper search failed with HTTP ${response.status}`);
    let data: unknown;
    try {
      data = await safeResponseJson(response, SERPER_SEARCH_ENDPOINT);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new Error(`Serper search returned an invalid response: ${errorText(error, apiKey).slice(0, 300)}`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Serper returned an invalid response: expected object envelope');
    }
    const organic = (data as Record<string, unknown>).organic;
    if (!Array.isArray(organic)) {
      throw new Error('Serper returned an invalid response: expected organic array');
    }
    const hits: WebSearchHit[] = [];
    for (const row of organic) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const urlValue = typeof record.link === 'string' ? record.link.trim() : '';
      if (!urlValue || !isHttpUrl(urlValue) || !passesDomainFilters(urlValue, filters)) continue;
      const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
      const snippetRaw = typeof record.snippet === 'string' ? record.snippet.replace(/\s+/g, ' ').trim() : '';
      hits.push({
        title: (titleRaw || 'Untitled').slice(0, SERPER_TITLE_MAX_CHARS),
        url: urlValue,
        snippet: snippetRaw.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'serper',
      });
      if (hits.length >= numResults) break;
    }
    return { backend: 'serper', hits, generatedText: [] };
  },
};
