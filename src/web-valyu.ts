// Valyu web-search adapter (canonical WebSearchAdapter shape).
// Official: POST https://api.valyu.ai/v1/search, x-api-key VALYU_API_KEY,
// {query, max_num_results, included_sources/excluded_sources,
// start_date: YYYY-MM-DD (recency day/week/month/year -> 1/7/30/365 days)}.
// Success requires success==true; rows at results[{title,url,description,content}].
// Snippet prefers content, falls back to description; content-sourced hits are
// marked contentKind:"full" (reused response content only, no second fetch).
// One request, no retry. Direct env credentials only; failures never carry key.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const VALYU_SEARCH_ENDPOINT = 'https://api.valyu.ai/v1/search';
export const VALYU_SEARCH_RESULT_MAX = 20;

const VALYU_TITLE_MAX_CHARS = 500;

const VALYU_RECENCY_DAYS: Record<'day' | 'week' | 'month' | 'year', number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
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
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export const valyuSearchAdapter: WebSearchAdapter = {
  id: 'valyu',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.VALYU_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.VALYU_API_KEY?.trim();
    if (!apiKey) return { backend: 'valyu', hits: [], generatedText: [] };
    const count = Math.min(Math.max(Math.floor(input.limit), 1), VALYU_SEARCH_RESULT_MAX);
    const included = (input.domains ?? []).filter((d) => !d.startsWith('-'));
    const excluded = (input.domains ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
    const days = input.recency !== undefined ? VALYU_RECENCY_DAYS[input.recency] : undefined;
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': apiKey },
      undefined,
    );
    const response = await fetch(VALYU_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        query: input.query,
        max_num_results: count,
        ...(included.length > 0 ? { included_sources: included } : {}),
        ...(excluded.length > 0 ? { excluded_sources: excluded } : {}),
        ...(days !== undefined
          ? { start_date: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) }
          : {}),
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for valyu search');
    }
    if (!response.ok) throw new Error(`Valyu search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, VALYU_SEARCH_ENDPOINT)) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Valyu search returned an invalid response');
    }
    if (data.success !== true) throw new Error('Valyu search returned an invalid response');
    if (!Array.isArray(data.results)) throw new Error('Valyu search returned an invalid response');
    const hits: WebSearchHit[] = [];
    for (const row of data.results) {
      if (hits.length >= count) break;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const url = stringField(record.url, '');
      if (!isHttpUrl(url)) continue;
      const content = typeof record.content === 'string' && record.content.trim() ? record.content.trim() : '';
      const isFullContent = content.length > 0 && content.length <= WEB_GENERATED_TEXT_MAX_CHARS;
      const snippet = (content || stringField(record.description, '').trim()).slice(0, WEB_GENERATED_TEXT_MAX_CHARS);
      hits.push({
        title: stringField(record.title, 'Untitled').slice(0, VALYU_TITLE_MAX_CHARS),
        url,
        snippet,
        backend: 'valyu',
        ...(isFullContent ? { contentKind: 'full' as const } : {}),
      });
    }
    return { backend: 'valyu', hits, generatedText: [] };
  },
};
