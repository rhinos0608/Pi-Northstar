// TinyFish web-search adapter (canonical WebSearchAdapter shape).
// Official: GET https://api.search.tinyfish.ai?query=&include_domains=&
// exclude_domains=&recency_minutes= (day 1440 / week 10080 / month 43200 /
// year 525600), X-API-Key TINYFISH_API_KEY. Response
// {results:[{url,title,snippet,date?}]}; parseable date maps to publishedDate,
// unparseable dates omitted. No count/page params exist; first page only.
// Retrieval-only: generatedText always []. One request, no retry. Env-only
// credentials; failures never carry the key or upstream body.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const TINYFISH_SEARCH_ENDPOINT = 'https://api.search.tinyfish.ai';
export const TINYFISH_SEARCH_RESULT_MAX = 20;

const TITLE_MAX_CHARS = 500;

export const TINYFISH_RECENCY_MINUTES: Record<'day' | 'week' | 'month' | 'year', number> = {
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
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
  return typeof value === 'string' ? value : fallback;
}

function publishedDateOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed;
}

export const tinyfishSearchAdapter: WebSearchAdapter = {
  id: 'tinyfish',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.TINYFISH_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.TINYFISH_API_KEY?.trim();
    if (!apiKey) return { backend: 'tinyfish', hits: [], generatedText: [] };
    const maxResults = Math.min(Math.max(Math.floor(input.limit), 1), TINYFISH_SEARCH_RESULT_MAX);
    const params = new URLSearchParams({ query: input.query });
    const include = (input.domains ?? []).filter((d) => !d.startsWith('-'));
    const exclude = (input.domains ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
    if (include.length > 0) params.set('include_domains', include.join(','));
    if (exclude.length > 0) params.set('exclude_domains', exclude.join(','));
    if (input.recency !== undefined) {
      params.set('recency_minutes', String(TINYFISH_RECENCY_MINUTES[input.recency]));
    }
    const url = `${TINYFISH_SEARCH_ENDPOINT}?${params.toString()}`;
    // Deadline comes from the runtime-composed policy signal (already bounded
    // by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped; only
    // standalone calls without a signal get the bounded fetchInit default.
    const validated = fetchInit(
      { Accept: 'application/json', 'X-API-Key': apiKey },
      undefined,
    );
    const response = await fetch(url, {
      method: 'GET',
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for tinyfish search');
    }
    if (!response.ok) throw new Error(`Tinyfish search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, TINYFISH_SEARCH_ENDPOINT)) as {
      results?: unknown;
    };
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.results)) {
      throw new Error('Tinyfish search returned an invalid response');
    }
    const hits: WebSearchHit[] = [];
    for (const row of data.results) {
      if (hits.length >= maxResults) break;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const hitUrl = stringField(record.url, '');
      if (!isHttpUrl(hitUrl)) continue;
      const publishedDate = publishedDateOf(record.date);
      const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
      hits.push({
        title: (titleRaw || 'Untitled').slice(0, TITLE_MAX_CHARS),
        url: hitUrl,
        snippet: stringField(record.snippet, '').trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'tinyfish',
        ...(publishedDate !== undefined ? { publishedDate } : {}),
      });
    }
    return { backend: 'tinyfish', hits, generatedText: [] };
  },
};
