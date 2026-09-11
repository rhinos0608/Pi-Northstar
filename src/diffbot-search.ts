/**
 * Diffbot Web Search adapter (wired via SEARCH_BACKENDS in src/web.ts).
 *
 * POSTs JSON to the fixed `llm.diffbot.com` host with Bearer auth via the
 * shared `diffbotFetch` transport, validates the response boundary, and
 * normalizes `search_results[]` rows to WebResult-compatible rows.
 * Never logs query/token. No registry wiring here.
 */
import { DIFFBOT_LLM_HOST, DiffbotError, diffbotFetch, resolveDiffbotSpend } from './diffbot-transport.js';

export const DIFFBOT_WEB_SEARCH_PATH = '/api/v1/web_search';
export const DIFFBOT_WEB_SEARCH_SOURCE = 'diffbot';
export const DIFFBOT_WEB_SEARCH_SIZE_MAX = 50;

export interface DiffbotWebResult {
  title: string;
  url: string;
  snippet?: string | undefined;
  source?: string | undefined;
}

export interface DiffbotSearchOptions {
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** True iff DIFFBOT_TOKEN is set (non-blank). No network use. */
export function diffbotConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.DIFFBOT_TOKEN?.trim());
}

function tokenOf(env: Record<string, string | undefined>): string | undefined {
  const token = env.DIFFBOT_TOKEN?.trim();
  return token ? token : undefined;
}

/**
 * Run a Diffbot web search. Returns [] when unconfigured (existing
 * unconfigured-backend convention). Throws DiffbotError otherwise:
 * contract_invalid_response on bad input/shape, upstream/transport errors
 * from the shared transport. Results bounded to `limit`.
 */
export async function searchDiffbot(
  query: string,
  limit: number,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  options?: DiffbotSearchOptions,
): Promise<DiffbotWebResult[]> {
  const text = query?.trim();
  if (!text) throw new DiffbotError('contract_invalid_response', 'Diffbot web search query is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > DIFFBOT_WEB_SEARCH_SIZE_MAX) {
    throw new DiffbotError(
      'contract_invalid_response',
      `Diffbot web search limit must be an integer in [1, ${DIFFBOT_WEB_SEARCH_SIZE_MAX}]`,
    );
  }
  const token = tokenOf(env);
  if (!token) return [];
  const { searchSize } = resolveDiffbotSpend(env);
  if (limit > searchSize) {
    throw new DiffbotError(
      'contract_invalid_response',
      `Diffbot web search limit ${limit} exceeds DIFFBOT_SEARCH_SIZE ${searchSize} (out of range, never clamped)`,
    );
  }
  const body: Record<string, unknown> = { text, size: limit };
  if (options?.maxTokens !== undefined) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new DiffbotError('contract_invalid_response', 'Diffbot web search maxTokens must be a positive integer');
    }
    body.maxTokens = options.maxTokens;
  }
  const data = await diffbotFetch<unknown>({
    host: DIFFBOT_LLM_HOST,
    path: DIFFBOT_WEB_SEARCH_PATH,
    method: 'POST',
    token,
    bearer: true,
    body,
    ...(signal !== undefined ? { signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const rows = mapDiffbotResults(data, limit);
  if (rows === undefined) throw new DiffbotError('contract_invalid_response', 'Diffbot web search response is not a valid result object');
  return rows;
}

/**
 * Validate response boundary and normalize rows. Returns undefined when the
 * envelope is not a valid result object (caller throws). Accepts canonical
 * `search_results` plus legacy `data`/`results` aliases. Only rows with a
 * non-empty http(s) URL survive; title/snippet trimmed; bounded to `limit`.
 */
export function mapDiffbotResults(data: unknown, limit: number): DiffbotWebResult[] | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const envelope = data as Record<string, unknown>;
  const raw = Array.isArray(envelope.search_results)
    ? envelope.search_results
    : Array.isArray(envelope.data)
      ? envelope.data
      : Array.isArray(envelope.results)
        ? envelope.results
        : undefined;
  if (raw === undefined) return undefined;
  const rows: DiffbotWebResult[] = [];
  for (const item of raw) {
    if (rows.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const url = firstString(record.pageUrl, record.url, record.link);
    if (!isHttpUrl(url)) continue;
    const title = firstString(record.title) || url;
    const snippet = firstString(record.content, record.snippet, record.description);
    const row: DiffbotWebResult = { title, url };
    if (snippet) row.snippet = snippet;
    row.source = DIFFBOT_WEB_SEARCH_SOURCE;
    rows.push(row);
  }
  return rows;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isHttpUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
