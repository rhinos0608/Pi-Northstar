// Querit web-search adapter (canonical WebSearchAdapter shape).
// Official: POST https://api.querit.ai/v1/search, Bearer QUERIT_API_KEY,
// {query, count:1..20, filters:{sites:{include,exclude}, timeRange:{date:d1/w1/m1/y1}}};
// success requires error_code==200, rows at results.result[{url,title,snippet}].
// Official `from` pagination exists but is never sent (first-page-only).
// page_age is dropped (relative value, no safe timestamp mapping).
// One request, no retry. Direct env credentials only; failures never carry key.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const QUERIT_SEARCH_ENDPOINT = 'https://api.querit.ai/v1/search';
export const QUERIT_SEARCH_RESULT_MAX = 20;

const QUERIT_TITLE_MAX_CHARS = 500;

const QUERIT_DATE: Record<'day' | 'week' | 'month' | 'year', string> = {
  day: 'd1',
  week: 'w1',
  month: 'm1',
  year: 'y1',
};

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export const queritSearchAdapter: WebSearchAdapter = {
  id: 'querit',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.QUERIT_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.QUERIT_API_KEY?.trim();
    if (!apiKey) return { backend: 'querit', hits: [], generatedText: [] };
    const count = Math.min(Math.max(Math.floor(input.limit), 1), QUERIT_SEARCH_RESULT_MAX);
    const include = (input.domains ?? []).filter((d) => !d.startsWith('-'));
    const exclude = (input.domains ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
    const filters: Record<string, unknown> = {};
    if (include.length > 0 || exclude.length > 0) {
      filters.sites = { ...(include.length > 0 ? { include } : {}), ...(exclude.length > 0 ? { exclude } : {}) };
    }
    if (input.recency !== undefined) filters.timeRange = { date: QUERIT_DATE[input.recency] };
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      undefined,
    );
    const response = await fetch(QUERIT_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        query: input.query,
        count,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for querit search');
    }
    if (!response.ok) throw new Error(`Querit search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, QUERIT_SEARCH_ENDPOINT)) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Querit search returned an invalid response');
    }
    if (Number(data.error_code) !== 200) {
      const detail = typeof data.error_msg === 'string' && data.error_msg.trim()
        ? `: ${data.error_msg.trim().slice(0, 200)}`
        : '';
      throw new Error(`Querit search returned error ${String(data.error_code ?? 'unknown')}${detail}`);
    }
    const results = data.results as Record<string, unknown> | undefined;
    const items = results?.result;
    if (!Array.isArray(items)) throw new Error('Querit search returned an invalid response');
    const hits: WebSearchHit[] = [];
    for (const row of items) {
      if (hits.length >= count) break;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const url = stringField(record.url, '');
      if (!isHttpUrl(url)) continue;
      hits.push({
        title: stringField(record.title, 'Untitled').slice(0, QUERIT_TITLE_MAX_CHARS),
        url,
        snippet: stringField(record.snippet, '').trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'querit',
      });
    }
    return { backend: 'querit', hits, generatedText: [] };
  },
};
