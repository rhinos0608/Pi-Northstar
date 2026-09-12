// Bocha web-search adapter (canonical WebSearchAdapter shape).
// Official: POST https://api.bochaai.com/v1/web-search, Bearer BOCHA_API_KEY,
// {query, count, freshness: oneDay/oneWeek/oneMonth/oneYear/noLimit, summary}.
// Rows at data.webPages.value[{url|link|href, title|name,
// summary|snippet|description|content}]. datePublished maps to publishedDate
// when parseable, otherwise omitted. Retrieval snippets stay on hits; the
// provider summary rides generatedText (kind:"summary") only when the caller
// enables native-AI summaries. One request, no retry. Direct env credentials
// only; failures never carry the key.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  WEB_GENERATED_TEXT_MAX_ITEMS,
  type WebGeneratedText,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const BOCHA_SEARCH_ENDPOINT = 'https://api.bochaai.com/v1/web-search';
export const BOCHA_SEARCH_RESULT_MAX = 20;

const BOCHA_TITLE_MAX_CHARS = 500;

const BOCHA_FRESHNESS: Record<'day' | 'week' | 'month' | 'year', string> = {
  day: 'oneDay',
  week: 'oneWeek',
  month: 'oneMonth',
  year: 'oneYear',
};

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function toPublishedDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export const bochaSearchAdapter: WebSearchAdapter = {
  id: 'bocha',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.BOCHA_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.BOCHA_API_KEY?.trim();
    if (!apiKey) return { backend: 'bocha', hits: [], generatedText: [] };
    const count = Math.min(Math.max(Math.floor(input.limit), 1), BOCHA_SEARCH_RESULT_MAX);
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      undefined,
    );
    const response = await fetch(BOCHA_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        query: input.query,
        count,
        freshness: input.recency !== undefined ? BOCHA_FRESHNESS[input.recency] : 'noLimit',
        summary: input.nativeAi.summaries,
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for bocha search');
    }
    if (!response.ok) throw new Error(`Bocha search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, BOCHA_SEARCH_ENDPOINT)) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Bocha search returned an invalid response');
    }
    const payload = data.data as Record<string, unknown> | undefined;
    const pages = payload?.webPages as Record<string, unknown> | undefined;
    const items = pages?.value;
    if (!Array.isArray(items)) throw new Error('Bocha search returned an invalid response');
    const hits: WebSearchHit[] = [];
    const generatedText: WebGeneratedText[] = [];
    for (const row of items) {
      if (hits.length >= count) break;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const url = firstString(record.url, record.link, record.href);
      if (url === undefined || !isHttpUrl(url)) continue;
      const summary = firstString(record.summary);
      hits.push({
        title: (firstString(record.title, record.name) ?? url).slice(0, BOCHA_TITLE_MAX_CHARS),
        url,
        snippet: (firstString(record.summary, record.snippet, record.description, record.content) ?? '')
          .slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'bocha',
        ...(toPublishedDate(record.datePublished) !== undefined
          ? { publishedDate: toPublishedDate(record.datePublished)! }
          : {}),
      });
      if (input.nativeAi.summaries && summary && generatedText.length < WEB_GENERATED_TEXT_MAX_ITEMS) {
        generatedText.push({
          kind: 'summary',
          backend: 'bocha',
          url,
          text: summary.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
          provenance: { kind: 'result_url', urls: [url] },
          claimCitations: false,
        });
      }
    }
    return { backend: 'bocha', hits, generatedText };
  },
};
