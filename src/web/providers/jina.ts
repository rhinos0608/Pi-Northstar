/**
 * Jina Search and Reader adapters (approved Firecrawl/Jina plan, Task 2).
 *
 * Search: `GET https://s.jina.ai/?q=<encoded-query>` with
 * `Accept: application/json`. Reader: `GET https://r.jina.ai/<validated-url>`.
 * Fixed origins only; bearer credential sent solely to the fixed vendor host.
 * One request per attempt, redirects rejected, no retries, no invented AI
 * output (search and reader both emit `generatedText: []`).
 *
 * Reader targets pass local public-URL validation plus system-DNS
 * public-host preflight BEFORE the vendor receives them. Preflight cannot
 * constrain vendor-side redirect hops (residual risk).
 */

import { resolvePublicHostname } from '../../network-policy.js';
import { safeResponseText, validateHttpUrl } from '../../core/http.js';
import {
  DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  type WebFetchAdapter,
  type WebFetchAdapterInput,
  type WebFetchedPage,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from '../web-search-types.js';

export const JINA_SEARCH_ENDPOINT = 'https://s.jina.ai/';
export const JINA_READER_PREFIX = 'https://r.jina.ai/';
export const JINA_SEARCH_RESULT_MAX = 5;

const JINA_RESPONSE_MAX_BYTES = 1_000_000;
const JINA_PAGE_CONTENT_MAX_CHARS = 50_000;
const JINA_TITLE_MAX_CHARS = 1_000;
const JINA_SNIPPET_MAX_CHARS = 8_000;

function apiKey(env: Record<string, string | undefined>): string | undefined {
  const key = env.JINA_API_KEY?.trim();
  return key ? key : undefined;
}

function composeSearchSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal) return signal;
  return AbortSignal.timeout(DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS);
}

function composeFetchSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxChars);
}

function searchRowToHit(row: unknown): WebSearchHit | undefined {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  if (!isHttpUrl(record.url)) return undefined;
  const url = (record.url as string).trim();
  const title = cleanText(record.title, JINA_TITLE_MAX_CHARS);
  const description = cleanText(record.description, JINA_SNIPPET_MAX_CHARS);
  const content = cleanText(record.content, JINA_SNIPPET_MAX_CHARS);
  const snippet = description || content;
  if (!snippet) return undefined;
  return { title, url, snippet, backend: 'jina' };
}

async function readBoundedJson(response: Response, url: string): Promise<unknown> {
  const text = await safeResponseText(response, url, JINA_RESPONSE_MAX_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
}

function requestHeaders(key: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
  };
}

async function getNoRedirect(url: string, key: string, signal: AbortSignal, label: string): Promise<Response> {
  const response = await fetch(url, {
    method: 'GET',
    headers: requestHeaders(key),
    signal,
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Redirect rejected for ${label}: credentials are never forwarded off the fixed host`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${label}`);
  }
  return response;
}

async function runSearch(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
  const query = input.query?.trim();
  if (!query) throw new Error('Jina search requires a non-empty query');
  const key = apiKey(input.env);
  if (!key) throw new Error('Jina search is not configured (JINA_API_KEY)');
  const limit = Math.max(1, Math.min(Math.floor(input.limit) || 1, JINA_SEARCH_RESULT_MAX));
  const url = `${JINA_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const response = await getNoRedirect(url, key, composeSearchSignal(input.signal), JINA_SEARCH_ENDPOINT);
  const payload = await readBoundedJson(response, JINA_SEARCH_ENDPOINT);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Invalid Jina search response from ${JINA_SEARCH_ENDPOINT}`);
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error(`Invalid Jina search response from ${JINA_SEARCH_ENDPOINT}`);
  }
  const hits: WebSearchHit[] = [];
  for (const row of data) {
    if (hits.length >= limit) break;
    const hit = searchRowToHit(row);
    if (hit) hits.push(hit);
  }
  return { backend: 'jina', hits, generatedText: [] };
}

async function runFetch(input: WebFetchAdapterInput): Promise<WebFetchedPage> {
  const key = apiKey(input.env);
  if (!key) throw new Error('Jina reader is not configured (JINA_API_KEY)');
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS ||
    input.timeoutMs > MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be an integer in [${MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS}, ${MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS}]`,
    );
  }
  // Local admission BEFORE the vendor receives the target.
  const validated = validateHttpUrl(input.url);
  await resolvePublicHostname(new URL(validated).hostname, input.signal, input.lookup);
  const readerUrl = `${JINA_READER_PREFIX}${validated}`;
  const response = await getNoRedirect(
    readerUrl,
    key,
    composeFetchSignal(input.signal, input.timeoutMs),
    JINA_READER_PREFIX,
  );
  const payload = await readBoundedJson(response, JINA_READER_PREFIX);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Invalid Jina reader response from ${JINA_READER_PREFIX}`);
  }
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`Invalid Jina reader response from ${JINA_READER_PREFIX}`);
  }
  const record = data as Record<string, unknown>;
  const content = cleanText(record.content, JINA_PAGE_CONTENT_MAX_CHARS);
  if (!content) {
    throw new Error(`Empty Jina reader content from ${JINA_READER_PREFIX}`);
  }
  const title = cleanText(record.title, JINA_TITLE_MAX_CHARS);
  const resolved = isHttpUrl(record.url) ? (record.url as string).trim() : validated;
  return {
    url: resolved,
    title,
    content,
    backend: 'jina',
    externalProcessing: true,
    generatedText: [],
  };
}

export const jinaSearchAdapter: WebSearchAdapter = {
  id: 'jina',
  configured(env: Record<string, string | undefined>): boolean {
    return apiKey(env) !== undefined;
  },
  search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    return runSearch(input);
  },
};

export const jinaFetchAdapter: WebFetchAdapter = {
  id: 'jina',
  configured(env: Record<string, string | undefined>): boolean {
    return apiKey(env) !== undefined;
  },
  fetch(input: WebFetchAdapterInput): Promise<WebFetchedPage> {
    return runFetch(input);
  },
};
