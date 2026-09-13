// xAI web-search adapter (canonical WebSearchAdapter shape).
// Source: pinned pi-web-access xai-search.ts + official xAI Responses API docs
// (https://docs.x.ai/developers/tools/web-search, https://docs.x.ai/developers/models).
// POST fixed vendor endpoint with {model:'grok-4.6', input, tools:[{type:'web_search'}]}.
// Official allowed_domains deliberately unsent; canonical input carries no
// domain/recency filters. One request, no retry. Env-only credentials;
// failures never carry the key or upstream body.

import { fetchInit, safeResponseJson } from '../../core/http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from '../web-search-types.js';

export const XAI_SEARCH_ENDPOINT = 'https://api.x.ai/v1/responses';
export const XAI_SEARCH_MODEL = 'grok-4.6';
export const XAI_SEARCH_RESULT_MAX = 20;

const TITLE_MAX_CHARS = 500;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Collect one source URL preserving first-seen order; http(s) only, deduped. */
function collectSource(
  hits: Array<{ title: string; url: string; snippet: string }>,
  seen: Set<string>,
  title: unknown,
  url: unknown,
  snippet: unknown,
): void {
  if (typeof url !== 'string') return;
  const trimmed = url.trim();
  if (!isHttpUrl(trimmed) || seen.has(trimmed)) return;
  seen.add(trimmed);
  const titleText = typeof title === 'string' && title.trim() ? title.trim() : 'Untitled';
  const snippetText = typeof snippet === 'string' ? snippet.trim() : '';
  hits.push({
    title: titleText.slice(0, TITLE_MAX_CHARS),
    url: trimmed,
    snippet: snippetText.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
  });
}

export const xaiSearchAdapter: WebSearchAdapter = {
  id: 'xai',
  configured(env: Record<string, string | undefined>): boolean {
    return (env.XAI_API_KEY?.trim().length ?? 0) > 0;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.XAI_API_KEY?.trim();
    if (!apiKey) return { backend: 'xai', hits: [], generatedText: [] };
    const maxResults = Math.min(Math.max(Math.floor(input.limit), 1), XAI_SEARCH_RESULT_MAX);
    // Deadline comes from the runtime-composed policy signal (already bounded
    // by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped; only
    // standalone calls without a signal get the bounded fetchInit default.
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      undefined,
    );
    const response = await fetch(XAI_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        model: XAI_SEARCH_MODEL,
        input: input.query,
        tools: [{ type: 'web_search' }],
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for xai search');
    }
    // Status-only error: upstream body (e.g. 403 spending-limit detail) and
    // credentials never enter the message.
    if (!response.ok) throw new Error(`XAI search failed with HTTP ${response.status}`);
    const data = (await safeResponseJson(response, XAI_SEARCH_ENDPOINT)) as {
      output?: unknown;
      citations?: unknown;
    };
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('XAI search returned an invalid response');
    }
    const output = Array.isArray(data.output) ? data.output : [];
    const answerParts: string[] = [];
    // Tier 1: url_citation annotations on message content parts.
    const annotated: Array<{ title: unknown; url: unknown; snippet: unknown }> = [];
    // Tier 2: web_search_call sources.
    const called: Array<{ title: unknown; url: unknown; snippet: unknown }> = [];
    for (const item of output) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (entry.type === 'message' && Array.isArray(entry.content)) {
        for (const part of entry.content as unknown[]) {
          if (typeof part !== 'object' || part === null || Array.isArray(part)) continue;
          const chunk = part as Record<string, unknown>;
          if (typeof chunk.text === 'string' && chunk.text.trim()) {
            answerParts.push(chunk.text.trim());
          }
          if (Array.isArray(chunk.annotations)) {
            for (const annotation of chunk.annotations as unknown[]) {
              if (typeof annotation !== 'object' || annotation === null || Array.isArray(annotation)) continue;
              const note = annotation as Record<string, unknown>;
              if (note.type !== 'url_citation') continue;
              annotated.push({ title: note.title, url: note.url, snippet: note.snippet ?? note.description });
            }
          }
        }
        continue;
      }
      if (typeof entry.type === 'string' && entry.type.endsWith('web_search_call') && Array.isArray(entry.sources)) {
        for (const source of entry.sources as unknown[]) {
          if (typeof source === 'string') {
            called.push({ title: undefined, url: source, snippet: undefined });
            continue;
          }
          if (typeof source !== 'object' || source === null || Array.isArray(source)) continue;
          const record = source as Record<string, unknown>;
          called.push({
            title: record.title ?? record.caption,
            url: record.url ?? record.source_website_url,
            snippet: record.snippet ?? record.description,
          });
        }
      }
    }
    // Tier 3: top-level citations (strings or {url,title} objects).
    const cited: Array<{ title: unknown; url: unknown; snippet: unknown }> = [];
    if (Array.isArray(data.citations)) {
      for (const source of data.citations as unknown[]) {
        if (typeof source === 'string') {
          cited.push({ title: undefined, url: source, snippet: undefined });
          continue;
        }
        if (typeof source !== 'object' || source === null || Array.isArray(source)) continue;
        const record = source as Record<string, unknown>;
        cited.push({
          title: record.title ?? record.caption,
          url: record.url ?? record.source_website_url,
          snippet: record.snippet ?? record.description,
        });
      }
    }
    const collected: Array<{ title: string; url: string; snippet: string }> = [];
    const seen = new Set<string>();
    for (const tier of [annotated, called, cited]) {
      for (const source of tier) {
        collectSource(collected, seen, source.title, source.url, source.snippet);
        if (collected.length >= maxResults) break;
      }
      if (collected.length >= maxResults) break;
    }
    const answer = answerParts.join('\n').trim();
    if (!answer && collected.length === 0) {
      throw new Error('XAI search returned an invalid response');
    }
    const hits: WebSearchHit[] = collected.slice(0, maxResults).map((row) => ({
      title: row.title,
      url: row.url,
      snippet: row.snippet,
      backend: 'xai' as const,
    }));
    // Native answer stays verbatim under generatedText; never replaces snippets.
    const generatedText: WebProviderSearchOutput['generatedText'] = [];
    if (input.nativeAi.answers && answer.length > 0 && hits.length > 0) {
      generatedText.push({
        kind: 'answer',
        backend: 'xai',
        text: answer.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        provenance: { kind: 'supporting_result_set', urls: hits.map((hit) => hit.url) },
        claimCitations: false,
      });
    }
    return { backend: 'xai', hits, generatedText };
  },
};
