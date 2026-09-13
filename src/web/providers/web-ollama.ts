// Ollama web-search adapter (canonical WebSearchAdapter shape).
// Exact behavior extraction from the legacy inline adapter in src/web.ts:
// POST {operator base}/api/experimental/web_search with {query, max_results},
// optional Bearer key, {results:[{title,url,content}]} mapping. One request,
// no retry. Base URL is operator-owned (may be loopback): raw fetch with no
// public-URL validation, matching the source. Failures never carry the key.

import { fetchInit, safeResponseJson } from '../../core/http.js';
import type {
  WebProviderSearchInput,
  WebProviderSearchOutput,
  WebSearchAdapter,
  WebSearchHit,
} from '../web-search-types.js';

export const OLLAMA_SEARCH_PATH = '/api/experimental/web_search';

function baseOf(env: Record<string, string | undefined>): string | undefined {
  const raw = env.OLLAMA_SEARCH_BASE_URL ?? env.SEARCH_OLLAMA_BASE_URL;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function keyOf(env: Record<string, string | undefined>): string | undefined {
  const raw = env.OLLAMA_SEARCH_API_KEY ?? env.SEARCH_OLLAMA_API_KEY;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export const ollamaSearchAdapter: WebSearchAdapter = {
  id: 'ollama-search',
  configured(env: Record<string, string | undefined>): boolean {
    return baseOf(env) !== undefined;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const baseUrl = baseOf(input.env);
    if (!baseUrl) return { backend: 'ollama-search', hits: [], generatedText: [] };
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const apiKey = keyOf(input.env);
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const searchUrl = `${baseUrl.replace(/\/+$/, '')}${OLLAMA_SEARCH_PATH}`;
    const response = await fetch(searchUrl, {
      method: 'POST',
      body: JSON.stringify({ query: input.query, max_results: input.limit }),
      ...fetchInit(headers, input.signal),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for Ollama search`);
    const data = (await safeResponseJson(response, searchUrl)) as {
      results?: Array<Record<string, unknown>>;
    };
    const hits: WebSearchHit[] = (data.results ?? [])
      .slice(0, input.limit)
      .map((result) => ({
        title: stringField(result.title, 'Untitled'),
        url: stringField(result.url, ''),
        snippet: stringField(result.content, ''),
        backend: 'ollama-search' as const,
      }))
      .filter((hit) => hit.url);
    return { backend: 'ollama-search', hits, generatedText: [] };
  },
};
