// Parallel web-search adapter (canonical WebSearchAdapter shape).
// Official: POST https://api.parallel.ai/v1/search, x-api-key PARALLEL_API_KEY
// (min 8 chars), {objective, search_queries:[query],
// advanced_settings:{max_results}}. Response {results:[{url,title,excerpts[]}]};
// excerpts joined into the hit snippet. Retrieval-only: generatedText always [].
// after_date / domain filter nesting is unverified at pin, so recency/domains
// stay unsent (no unsupported params). One request, no retry. Env-only
// credentials; failures never carry the key or upstream body.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const PARALLEL_SEARCH_ENDPOINT = 'https://api.parallel.ai/v1/search';
export const PARALLEL_SEARCH_RESULT_MAX = 20;
export const PARALLEL_API_KEY_MIN_LENGTH = 8;

const TITLE_MAX_CHARS = 500;

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

function excerptsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join('\n\n')
    .trim()
    .slice(0, WEB_GENERATED_TEXT_MAX_CHARS);
}

export const parallelSearchAdapter: WebSearchAdapter = {
  id: 'parallel',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.PARALLEL_API_KEY?.trim().length ?? 0) >= PARALLEL_API_KEY_MIN_LENGTH;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.PARALLEL_API_KEY?.trim();
    if (!apiKey || apiKey.length < PARALLEL_API_KEY_MIN_LENGTH) {
      return { backend: 'parallel', hits: [], generatedText: [] };
    }
    const maxResults = Math.min(Math.max(Math.floor(input.limit), 1), PARALLEL_SEARCH_RESULT_MAX);
    // Deadline comes from the runtime-composed policy signal (already bounded
    // by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped; only
    // standalone calls without a signal get the bounded fetchInit default.
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': apiKey },
      undefined,
    );
    const response = await fetch(PARALLEL_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        objective: input.query,
        search_queries: [input.query],
        advanced_settings: { max_results: maxResults },
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for parallel search');
    }
    if (!response.ok) throw new Error(`Parallel search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, PARALLEL_SEARCH_ENDPOINT)) as {
      results?: unknown;
    };
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.results)) {
      throw new Error('Parallel search returned an invalid response');
    }
    const hits: WebSearchHit[] = [];
    for (const row of data.results.slice(0, maxResults)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const url = stringField(record.url, '');
      if (!isHttpUrl(url)) continue;
      hits.push({
        title: stringField(record.title, 'Untitled').slice(0, TITLE_MAX_CHARS),
        url,
        snippet: excerptsText(record.excerpts),
        backend: 'parallel',
      });
    }
    return { backend: 'parallel', hits, generatedText: [] };
  },
};
