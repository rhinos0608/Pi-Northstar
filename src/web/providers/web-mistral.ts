// Mistral web-search adapter (canonical WebSearchAdapter shape).
// Source: pinned pi-web-access mistral-search.ts + official Mistral docs
// (https://docs.mistral.ai/studio/agents/agent-tools/websearch,
//  https://docs.mistral.ai/studio/connectors/conversations).
// POST Conversations API with fixed model 'mistral-small-latest' and a
// web_search tool. tool_reference order preserved; canonical input carries
// no domain/recency filters. One request, no retry. Env-only credentials;
// failures never carry the key or upstream body.

import { fetchInit, safeResponseJson } from '../../core/http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from '../web-search-types.js';

export const MISTRAL_CONVERSATIONS_ENDPOINT = 'https://api.mistral.ai/v1/conversations';
export const MISTRAL_SEARCH_MODEL = 'mistral-small-latest';
export const MISTRAL_SEARCH_RESULT_MAX = 20;

const TITLE_MAX_CHARS = 500;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const mistralSearchAdapter: WebSearchAdapter = {
  id: 'mistral',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.MISTRAL_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.MISTRAL_API_KEY?.trim();
    if (!apiKey) return { backend: 'mistral', hits: [], generatedText: [] };
    const maxResults = Math.min(Math.max(Math.floor(input.limit), 1), MISTRAL_SEARCH_RESULT_MAX);
    // Deadline comes from the runtime-composed policy signal (already bounded
    // by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped; only
    // standalone calls without a signal get the bounded fetchInit default.
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      undefined,
    );
    const response = await fetch(MISTRAL_CONVERSATIONS_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        inputs: [{ role: 'user', content: input.query }],
        stream: false,
        model: MISTRAL_SEARCH_MODEL,
        tools: [{ type: 'web_search' }],
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for mistral search');
    }
    // Status-only error: upstream body and credentials never enter the message.
    if (!response.ok) throw new Error(`Mistral search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, MISTRAL_CONVERSATIONS_ENDPOINT)) as {
      outputs?: unknown;
    };
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.outputs)) {
      throw new Error('Mistral search returned an invalid response');
    }
    const answers: string[] = [];
    const collected: Array<{ title: string; url: string; snippet: string }> = [];
    const seen = new Set<string>();
    for (const item of data.outputs as unknown[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (entry.type !== 'message.output') continue;
      if (typeof entry.content === 'string') {
        if (entry.content.trim()) answers.push(entry.content.trim());
        continue;
      }
      if (!Array.isArray(entry.content)) continue;
      for (const chunk of entry.content as unknown[]) {
        if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) continue;
        const part = chunk as Record<string, unknown>;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          answers.push(part.text.trim());
          continue;
        }
        if (part.type !== 'tool_reference' || collected.length >= maxResults) continue;
        if (typeof part.url !== 'string') continue;
        const url = part.url.trim();
        if (!isHttpUrl(url) || seen.has(url)) continue;
        seen.add(url);
        const title = typeof part.title === 'string' && part.title.trim() ? part.title.trim() : 'Untitled';
        const snippet = typeof part.description === 'string' ? part.description.trim() : '';
        collected.push({
          title: title.slice(0, TITLE_MAX_CHARS),
          url,
          snippet: snippet.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        });
      }
      if (collected.length >= maxResults) break;
    }
    const answer = answers.join('\n').trim();
    if (!answer && collected.length === 0) {
      throw new Error('Mistral search returned an invalid response');
    }
    const hits: WebSearchHit[] = collected.slice(0, maxResults).map((row) => ({
      title: row.title,
      url: row.url,
      snippet: row.snippet,
      backend: 'mistral' as const,
    }));
    // Native answer stays verbatim under generatedText; never replaces snippets.
    const generatedText: WebProviderSearchOutput['generatedText'] = [];
    if (input.nativeAi.answers && answer.length > 0 && hits.length > 0) {
      generatedText.push({
        kind: 'answer',
        backend: 'mistral',
        text: answer.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        provenance: { kind: 'supporting_result_set', urls: hits.map((hit) => hit.url) },
        claimCitations: false,
      });
    }
    return { backend: 'mistral', hits, generatedText };
  },
};
