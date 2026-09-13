// Firecrawl search + fetch adapters (approved firecrawl/jina plan, Task 1).
// Fixed vendor endpoints, one request per attempt, no retries, no cookie or
// caller-header forwarding. Fetch targets pass local public-URL validation
// and DNS preflight before the vendor receives them. Fetch summary format and
// item honor PI_SEARCH_NATIVE_SUMMARIES (default-on).

import { safeResponseJson, validateHttpUrl } from '../../core/http.js';
import { parseNativeAiFlag } from '../web-native-ai.js';
import { resolvePublicHostname } from '../../network-policy.js';
import {
  DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebFetchAdapter,
  type WebFetchAdapterInput,
  type WebFetchedPage,
  type WebGeneratedText,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from '../web-search-types.js';

export const FIRECRAWL_SEARCH_ENDPOINT = 'https://api.firecrawl.dev/v2/search';
export const FIRECRAWL_SCRAPE_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';
export const FIRECRAWL_SEARCH_RESULT_MAX = 10;
export const FIRECRAWL_SEARCH_SUMMARY_RESULT_MAX = 3;

const VENDOR_RESPONSE_MAX_BYTES = 1_000_000;
const FETCH_CONTENT_MAX_CHARS = 50_000;
const FETCH_TITLE_MAX_CHARS = 500;
const FETCH_TIMEOUT_MIN_MS = 1_000;
const FETCH_TIMEOUT_MAX_MS = 30_000;

function apiKey(env: Record<string, string | undefined>): string | undefined {
  const raw = env.FIRECRAWL_API_KEY;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function summariesEnabled(env: Record<string, string | undefined>): boolean {
  return parseNativeAiFlag(env.PI_SEARCH_NATIVE_SUMMARIES, 'PI_SEARCH_NATIVE_SUMMARIES');
}

function effectiveSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

// Search deadline comes from the runtime-composed policy signal (already
// bounded by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped;
// only standalone calls without a signal get the bounded default.
function searchSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? AbortSignal.timeout(DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function postJson(
  endpoint: string,
  key: string,
  body: unknown,
  signal: AbortSignal | undefined,
  // undefined = signal already carries the deadline (search path); a number
  // layers an additional bound (fetch path keeps timeoutMs input effective).
  timeoutMs: number | undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      ...(timeoutMs === undefined
        ? signal !== undefined
          ? { signal }
          : {}
        : { signal: effectiveSignal(signal, timeoutMs) }),
      redirect: 'manual',
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
    throw new Error(`Firecrawl transport failure for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Redirect rejected for ${endpoint}: credentials are never forwarded off the fixed host`);
  }
  if (!response.ok) {
    throw new Error(`Firecrawl API error (HTTP ${response.status}) for ${endpoint}`);
  }
  try {
    return await safeResponseJson(response, endpoint, VENDOR_RESPONSE_MAX_BYTES);
  } catch (error) {
    throw new Error(`Firecrawl response failure for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function snippetFromRow(row: Record<string, unknown>): string {
  const highlights = row.highlights;
  if (Array.isArray(highlights)) {
    const parts = highlights.filter(nonempty).map((part) => part.trim());
    if (parts.length > 0) return parts.join(' ').slice(0, 8000);
  }
  const description = row.description;
  if (nonempty(description)) return description.trim().slice(0, 8000);
  return '';
}

function summaryItem(url: string, summary: string): WebGeneratedText {
  return {
    kind: 'summary',
    backend: 'firecrawl',
    url,
    text: summary.trim().slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
    provenance: { kind: 'result_url', urls: [url] },
    claimCitations: false,
  };
}

async function runSearch(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
  const key = apiKey(input.env);
  if (!key) throw new Error('FIRECRAWL_API_KEY is not configured');
  const query = input.query?.trim() ?? '';
  if (!query) throw new Error('Firecrawl search requires a non-empty query');
  const withSummary = input.nativeAi.summaries;
  const cap = withSummary ? FIRECRAWL_SEARCH_SUMMARY_RESULT_MAX : FIRECRAWL_SEARCH_RESULT_MAX;
  const limit = Math.min(Math.max(input.limit, 1), cap);
  const body: Record<string, unknown> = {
    query,
    limit,
    sources: ['web'],
    highlights: true,
    ...(withSummary ? { scrapeOptions: { formats: [{ type: 'summary' }], onlyMainContent: true } } : {}),
  };
  const parsed = await postJson(
    FIRECRAWL_SEARCH_ENDPOINT,
    key,
    body,
    searchSignal(input.signal),
    undefined,
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Firecrawl search response is not an object');
  }
  const envelope = parsed as { success?: unknown; data?: unknown };
  if (envelope.success !== true) throw new Error('Firecrawl search response success !== true');
  if (typeof envelope.data !== 'object' || envelope.data === null || Array.isArray(envelope.data)) {
    throw new Error('Firecrawl search response data is not an object');
  }
  const web = (envelope.data as { web?: unknown }).web;
  if (!Array.isArray(web)) throw new Error('Firecrawl search response data.web is not an array');
  const hits: WebSearchHit[] = [];
  const generatedText: WebGeneratedText[] = [];
  for (const entry of web) {
    if (hits.length >= limit) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (!isHttpUrl(row.url)) continue;
    const url = row.url;
    const title = nonempty(row.title) ? row.title.trim().slice(0, 500) : url;
    hits.push({ title, url, snippet: snippetFromRow(row), backend: 'firecrawl' });
    if (withSummary && nonempty(row.summary)) {
      generatedText.push(summaryItem(url, row.summary));
    }
  }
  return { backend: 'firecrawl', hits, generatedText };
}

function resolveFetchTimeout(raw: number): number {
  if (!Number.isInteger(raw) || raw < FETCH_TIMEOUT_MIN_MS || raw > FETCH_TIMEOUT_MAX_MS) {
    throw new Error(`timeoutMs must be an integer in [${FETCH_TIMEOUT_MIN_MS}, ${FETCH_TIMEOUT_MAX_MS}]`);
  }
  return raw;
}

async function runFetch(input: WebFetchAdapterInput): Promise<WebFetchedPage> {
  const key = apiKey(input.env);
  if (!key) throw new Error('FIRECRAWL_API_KEY is not configured');
  const timeoutMs = resolveFetchTimeout(input.timeoutMs);
  const withSummary = summariesEnabled(input.env);
  const validated = validateHttpUrl(input.url);
  const hostname = new URL(validated).hostname;
  await resolvePublicHostname(hostname, input.signal, input.lookup);
  const body: Record<string, unknown> = {
    url: validated,
    formats: withSummary ? ['markdown', { type: 'summary' }] : ['markdown'],
    onlyMainContent: true,
    timeout: timeoutMs,
  };
  const parsed = await postJson(FIRECRAWL_SCRAPE_ENDPOINT, key, body, input.signal, timeoutMs);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Firecrawl scrape response is not an object');
  }
  const envelope = parsed as { success?: unknown; data?: unknown };
  if (envelope.success !== true) throw new Error('Firecrawl scrape response success !== true');
  if (typeof envelope.data !== 'object' || envelope.data === null || Array.isArray(envelope.data)) {
    throw new Error('Firecrawl scrape response data is not an object');
  }
  const data = envelope.data as Record<string, unknown>;
  if (!nonempty(data.markdown)) throw new Error('Firecrawl scrape response has no markdown content');
  const metadata =
    typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : {};
  const title = nonempty(metadata.title) ? metadata.title.trim().slice(0, FETCH_TITLE_MAX_CHARS) : validated;
  const url = isHttpUrl(metadata.sourceURL) ? metadata.sourceURL : validated;
  const generatedText: WebGeneratedText[] = [];
  if (withSummary && nonempty(data.summary)) {
    generatedText.push(summaryItem(url, data.summary));
  }
  return {
    url,
    title,
    content: data.markdown.slice(0, FETCH_CONTENT_MAX_CHARS),
    backend: 'firecrawl',
    externalProcessing: true,
    generatedText,
  };
}

export const firecrawlSearchAdapter: WebSearchAdapter = {
  id: 'firecrawl',
  configured: (env) => apiKey(env) !== undefined,
  search: (input) => runSearch(input),
};

export const firecrawlFetchAdapter: WebFetchAdapter = {
  id: 'firecrawl',
  configured: (env) => apiKey(env) !== undefined,
  fetch: (input) => runFetch(input),
};
