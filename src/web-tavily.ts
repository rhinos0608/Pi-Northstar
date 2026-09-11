import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebGeneratedText,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
export const TAVILY_SEARCH_RESULT_MAX = 20;

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

export const tavilySearchAdapter: WebSearchAdapter = {
  id: 'tavily',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.TAVILY_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.TAVILY_API_KEY?.trim();
    if (!apiKey) return { backend: 'tavily', hits: [], generatedText: [] };
    const maxResults = Math.min(Math.max(Math.floor(input.limit), 1), TAVILY_SEARCH_RESULT_MAX);
    // Deadline comes from the runtime-composed policy signal (already bounded
    // by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped; only
    // standalone calls without a signal get the bounded fetchInit default.
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      undefined,
    );
    const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        query: input.query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: input.nativeAi.answers ? 'basic' : false,
        include_raw_content: false,
        include_images: false,
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for tavily search');
    }
    if (!response.ok) throw new Error(`Tavily search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, TAVILY_SEARCH_ENDPOINT)) as {
      answer?: unknown;
      results?: unknown;
    };
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.results)) {
      throw new Error('Tavily search returned an invalid response');
    }
    const hits: WebSearchHit[] = [];
    for (const row of data.results.slice(0, maxResults)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const url = stringField(record.url, '');
      if (!isHttpUrl(url)) continue;
      hits.push({
        title: stringField(record.title, 'Untitled'),
        url,
        snippet: stringField(record.content, '').trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'tavily',
      });
    }
    const generatedText: WebGeneratedText[] = [];
    if (input.nativeAi.answers) {
      const answer = stringField(data.answer, '').trim();
      const supporting = hits.map((hit) => hit.url);
      if (answer.length > 0 && supporting.length > 0) {
        generatedText.push({
          kind: 'answer',
          backend: 'tavily',
          text: answer.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
          provenance: { kind: 'supporting_result_set', urls: supporting },
          claimCitations: false,
        });
      }
    }
    return { backend: 'tavily', hits, generatedText };
  },
};
