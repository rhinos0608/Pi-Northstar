import { fetchInit, safeResponseJson } from '../../core/http.js';
import {
  terminalReportError,
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebGeneratedText,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from '../web-search-types.js';

export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
export const TAVILY_SEARCH_RESULT_MAX = 20;
export const TAVILY_RESEARCH_ENDPOINT = 'https://api.tavily.com/research';
export const TAVILY_RESEARCH_SOURCES_MAX = 20;
/** Explicit report-text boundary: oversized reports reject terminally, never truncate. */
export const TAVILY_RESEARCH_TEXT_MAX_CHARS = 50_000;
/** Total SSE transport bound: raw stream bytes before JSON framing. */
export const TAVILY_RESEARCH_STREAM_MAX_BYTES = 1_000_000;

export const TAVILY_RESEARCH_MODELS = ['mini', 'pro', 'auto'] as const;
export type TavilyResearchModel = (typeof TAVILY_RESEARCH_MODELS)[number];
export const DEFAULT_TAVILY_RESEARCH_MODEL: TavilyResearchModel = 'pro';

/** Operator model knob. Absent/blank defaults to 'pro'; anything else rejects before fetch. */
export function resolveTavilyResearchModel(env: Record<string, string | undefined>): TavilyResearchModel {
  const raw = env.TAVILY_RESEARCH_MODEL;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TAVILY_RESEARCH_MODEL;
  const value = raw.trim();
  if (value === 'mini' || value === 'pro' || value === 'auto') return value;
  throw new Error(`TAVILY_RESEARCH_MODEL: expected mini|pro|auto, got "${raw}"`);
}

/**
 * Streaming report run: POST {input, model, stream:true}, then consume the
 * OpenAI-style SSE stream (choices[0].delta.content chunks form the Markdown
 * report; delta.sources carries sources; `done` ends the stream) into one
 * assembled result. Single attempt — the operator deadline signal bounds the
 * whole POST + stream. Tool-call/progress events are ignored, never exposed.
 */
export async function runTavilyResearch(
  query: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<import('../web-search-types.js').WebReportResult> {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) throw terminalReportError('Tavily research is not configured');
  const model = resolveTavilyResearchModel(env);
  const validated = fetchInit(
    { Accept: 'text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    undefined,
  );
  const response = await fetch(TAVILY_RESEARCH_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ input: query, model, stream: true }),
    ...validated,
    ...(signal !== undefined ? { signal } : {}),
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw terminalReportError('Redirect rejected for tavily research');
  }
  if (!response.ok) throw terminalReportError(`Tavily research failed with HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    await response.body?.cancel().catch(() => undefined);
    throw terminalReportError('Tavily research returned an invalid response');
  }
  if (!response.body) throw terminalReportError('Tavily research returned an invalid response');
  return consumeResearchStream(response.body, signal);
}

/** Merge validated source rows into the running list: http(s) only, deduped, capped. */
function collectReportSources(
  raw: unknown,
  sources: Array<{ url: string; title: string }>,
  seen: Set<string>,
): void {
  if (!Array.isArray(raw)) return;
  for (const row of raw) {
    if (sources.length >= TAVILY_RESEARCH_SOURCES_MAX) break;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const urlValue = typeof record.url === 'string' ? record.url.trim() : '';
    if (!isHttpUrl(urlValue) || seen.has(urlValue)) continue;
    seen.add(urlValue);
    sources.push({ url: urlValue, title: stringField(record.title, 'Untitled') });
  }
}

interface StreamState {
  text: string;
  sources: Array<{ url: string; title: string }>;
  seen: Set<string>;
  done: boolean;
}

/** Apply one parsed SSE data payload: error verdicts fail, deltas accumulate, rest ignored. */
function applyStreamPayload(payload: unknown, state: StreamState): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  if (record.object === 'error' || (typeof record.error === 'string' && !Array.isArray(record.choices))) {
    throw terminalReportError('Tavily research stream failed');
  }
  const deltas: unknown[] = [];
  if (Array.isArray(record.choices)) {
    const first = record.choices[0] as Record<string, unknown> | undefined;
    if (typeof first?.delta === 'object' && first.delta !== null) deltas.push(first.delta);
  }
  if (typeof record.delta === 'object' && record.delta !== null) deltas.push(record.delta);
  for (const entry of deltas) {
    const delta = entry as Record<string, unknown>;
    // Only string content becomes report text; tool-call/progress payloads ignored.
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      state.text += delta.content;
      if (state.text.length > TAVILY_RESEARCH_TEXT_MAX_CHARS) {
        throw terminalReportError(
          `Tavily research response too large (${state.text.length} chars, max ${TAVILY_RESEARCH_TEXT_MAX_CHARS})`,
        );
      }
    }
    collectReportSources(delta.sources, state.sources, state.seen);
  }
  collectReportSources(record.sources, state.sources, state.seen);
}

/** Dispatch one SSE event: blank/comment/unknown ignored, `done` ends, data parsed. */
function dispatchStreamEvent(eventType: string, dataLines: string[], state: StreamState): void {
  if (eventType === 'done') {
    state.done = true;
    return;
  }
  const data = dataLines.join('\n');
  if (data === '') return;
  if (data === '[DONE]') {
    state.done = true;
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  applyStreamPayload(payload, state);
}

/**
 * Bounded incremental SSE parser over standard Web Streams. Handles arbitrary
 * byte/chunk splits (streaming TextDecoder for UTF-8 boundaries), CRLF/LF,
 * multi-line data, comments, and blank-event framing. Malformed JSON events
 * are skipped; a missing `done` or empty report fails terminally.
 */
async function consumeResearchStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<import('../web-search-types.js').WebReportResult> {
  const reader = body.getReader();
  signal?.throwIfAborted();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const state: StreamState = { text: '', sources: [], seen: new Set<string>(), done: false };
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let eventType = '';
  let dataLines: string[] = [];
  const dispatchPending = (): void => {
    dispatchStreamEvent(eventType, dataLines, state);
    eventType = '';
    dataLines = [];
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > TAVILY_RESEARCH_STREAM_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw terminalReportError(
          `Tavily research response too large (${bytes} bytes, max ${TAVILY_RESEARCH_STREAM_MAX_BYTES})`,
        );
      }
      buffer += decoder.decode(value, { stream: true });
      // Split complete lines; the trailing partial line stays buffered.
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          dispatchPending();
        } else if (line.startsWith(':')) {
          continue;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        }
      }
      if (state.done) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const line of buffer.split(/\r\n|\r|\n/)) {
        if (line === '') {
          dispatchPending();
        } else if (line.startsWith(':')) {
          continue;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        }
      }
    }
    if (dataLines.length > 0 || eventType !== '') dispatchPending();
  } catch (error) {
    if ((error as { name?: unknown })?.name === 'AbortError' || signal?.aborted) {
      throw error;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  // Abort racing a pending read can resolve done:true via our cancel; re-assert
  // the signal so the abort reason propagates instead of a terminal error.
  signal?.throwIfAborted();
  if (!state.done) throw terminalReportError('Tavily research returned an invalid response');
  if (!state.text.trim()) throw terminalReportError('Tavily research returned an invalid response');
  return { provider: 'tavily', text: state.text, sources: state.sources };
}

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

function splitTavilyDomains(domains: string[] | undefined): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of domains ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('-')) {
      const value = trimmed.slice(1).replace(/^\.+/, '');
      if (value) exclude.push(value);
    } else {
      const value = trimmed.replace(/^\.+/, '');
      if (value) include.push(value);
    }
  }
  return { include, exclude };
}

function tavilyDateRangeOf(input: WebProviderSearchInput): { start_date: string } | Record<string, never> {
  let bound = input.freshnessLowerBoundMs;
  if ((bound === undefined || !Number.isFinite(bound)) && (input.recency !== undefined || input.yearFrom !== undefined)) {
    let derived: number | undefined;
    if (input.recency !== undefined) {
      const now = Date.now();
      const date = new Date(now);
      switch (input.recency) {
        case 'day': derived = now - 24 * 60 * 60 * 1000; break;
        case 'week': derived = now - 7 * 24 * 60 * 60 * 1000; break;
        case 'month':
          derived = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, date.getUTCDate(), 0, 0, 0, 0);
          break;
        case 'year':
          derived = Date.UTC(date.getUTCFullYear() - 1, date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
          break;
      }
    }
    if (input.yearFrom !== undefined) {
      const yearBound = Date.UTC(input.yearFrom, 0, 1, 0, 0, 0, 0);
      derived = derived === undefined ? yearBound : Math.max(derived, yearBound);
    }
    bound = derived;
  }
  if (bound === undefined || !Number.isFinite(bound)) return {};
  // Lower bound only: an end_date of today would exclude current-day results
  // under Tavily's "before end_date" semantics. time_range (when recency is
  // set) carries the relative window alongside this explicit start_date.
  return {
    start_date: new Date(bound).toISOString().slice(0, 10),
  };
}

function tavilyPublishedDateOf(record: Record<string, unknown>): string | undefined {
  for (const key of ['published_date', 'publishedDate', 'date'] as const) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const trimmed = value.trim();
    if (!Number.isNaN(Date.parse(trimmed))) return trimmed;
  }
  return undefined;
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
    const { include, exclude } = splitTavilyDomains(input.domains);
    const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        query: input.query,
        max_results: maxResults,
        search_depth: 'advanced',
        include_answer: input.nativeAi.answers ? 'basic' : false,
        include_raw_content: false,
        include_images: false,
        ...(input.recency !== undefined ? { time_range: input.recency } : {}),
        ...tavilyDateRangeOf(input),
        ...(include.length > 0 ? { include_domains: include } : {}),
        ...(exclude.length > 0 ? { exclude_domains: exclude } : {}),
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
      const publishedDate = tavilyPublishedDateOf(record);
      hits.push({
        title: stringField(record.title, 'Untitled'),
        url,
        snippet: stringField(record.content, '').trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'tavily',
        ...(publishedDate !== undefined ? { publishedDate } : {}),
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
