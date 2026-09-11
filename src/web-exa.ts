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

export const EXA_SEARCH_ENDPOINT = 'https://api.exa.ai/search';
export const EXA_SEARCH_RESULT_MAX = 10;

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

function excerptFromRow(row: Record<string, unknown>): string {
  const highlights = row.highlights;
  if (Array.isArray(highlights)) {
    const joined = highlights.filter((h): h is string => typeof h === 'string').join(' ').trim();
    if (joined.length > 0) return joined.slice(0, WEB_GENERATED_TEXT_MAX_CHARS);
  } else if (typeof highlights === 'string' && highlights.trim().length > 0) {
    return highlights.trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS);
  }
  return stringField(row.text, '').trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS);
}

export const exaSearchAdapter: WebSearchAdapter = {
  id: 'exa',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.EXA_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.EXA_API_KEY?.trim();
    if (!apiKey) return { backend: 'exa', hits: [], generatedText: [] };
    const numResults = Math.min(Math.max(Math.floor(input.limit), 1), EXA_SEARCH_RESULT_MAX);
    const contents = input.nativeAi.summaries
      ? { text: true, highlights: true, summary: true }
      : { text: true, highlights: true };
    // Deadline comes from the runtime-composed policy signal (already bounded
    // by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped; only
    // standalone calls without a signal get the bounded fetchInit default.
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': apiKey },
      undefined,
    );
    const response = await fetch(EXA_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        query: input.query,
        numResults,
        type: 'auto',
        contents,
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for exa search');
    }
    if (!response.ok) throw new Error(`Exa search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, EXA_SEARCH_ENDPOINT)) as {
      results?: unknown;
    };
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.results)) {
      throw new Error('Exa search returned an invalid response');
    }
    const hits: WebSearchHit[] = [];
    const generatedText: WebGeneratedText[] = [];
    for (const row of data.results.slice(0, numResults)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const url = stringField(record.url, '');
      if (!isHttpUrl(url)) continue;
      hits.push({
        title: stringField(record.title, 'Untitled'),
        url,
        snippet: excerptFromRow(record),
        backend: 'exa',
      });
      if (input.nativeAi.summaries && generatedText.length < WEB_GENERATED_TEXT_MAX_ITEMS) {
        const summary = stringField(record.summary, '').trim();
        if (summary.length > 0) {
          generatedText.push({
            kind: 'summary',
            backend: 'exa',
            url,
            text: summary.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
            provenance: { kind: 'result_url', urls: [url] },
            claimCitations: false,
          });
        }
      }
    }
    return { backend: 'exa', hits, generatedText };
  },
};
