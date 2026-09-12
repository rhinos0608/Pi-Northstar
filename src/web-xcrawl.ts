// XCrawl web-search adapter (canonical WebSearchAdapter shape).
// Official SERP path: POST https://run.xcrawl.com/v1/serp, Bearer XCRAWL_API_KEY,
// {engine:'google_search', q}. No filter/date params are sent (first-page-only).
// Response {organic_results:[{title,link,snippet}]}; rows without a usable link
// are skipped and well-formed sibling rows map in order. One request, no retry. Direct env
// credentials only; failures never carry the key.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const XCRAWL_SERP_ENDPOINT = 'https://run.xcrawl.com/v1/serp';
export const XCRAWL_SEARCH_RESULT_MAX = 20;

const XCRAWL_TITLE_MAX_CHARS = 500;

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

export const xcrawlSearchAdapter: WebSearchAdapter = {
  id: 'xcrawl',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.XCRAWL_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.XCRAWL_API_KEY?.trim();
    if (!apiKey) return { backend: 'xcrawl', hits: [], generatedText: [] };
    const count = Math.min(Math.max(Math.floor(input.limit), 1), XCRAWL_SEARCH_RESULT_MAX);
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      undefined,
    );
    const response = await fetch(XCRAWL_SERP_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ engine: 'google_search', q: input.query }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for xcrawl search');
    }
    if (!response.ok) throw new Error(`XCrawl search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, XCRAWL_SERP_ENDPOINT)) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('XCrawl search returned an invalid response');
    }
    if (!Array.isArray(data.organic_results)) throw new Error('XCrawl search returned an invalid response');
    const hits: WebSearchHit[] = [];
    const rows = data.organic_results as unknown[];
    for (let index = 0; index < rows.length; index++) {
      if (hits.length >= count) break;
      const row = rows[index];
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      // Skip rows without a usable http(s) link; well-formed siblings map in order.
      if (typeof record.link !== 'string' || !isHttpUrl(record.link.trim())) continue;
      hits.push({
        title: stringField(record.title, 'Untitled').slice(0, XCRAWL_TITLE_MAX_CHARS),
        url: record.link.trim(),
        snippet: stringField(record.snippet, '').trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'xcrawl',
      });
    }
    return { backend: 'xcrawl', hits, generatedText: [] };
  },
};
