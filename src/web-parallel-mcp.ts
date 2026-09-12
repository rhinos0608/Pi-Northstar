// Parallel MCP web-search adapter (canonical WebSearchAdapter shape).
// Official: POST https://search.parallel.ai/mcp, Streamable JSON-RPC
// tools/call {name:'web_search', arguments:{objective, search_queries:[query]}},
// optional Bearer PARALLEL_API_KEY (anonymous allowed, always configured).
// Result rows parsed in order: result.structuredContent (array or {results}),
// then JSON text blocks in result.content (array or {results} envelope), then
// labeled-text fallback (Title:/URL:/Text: blocks). Local slice to 20; no
// server max_results param exists. Retrieval-only: generatedText always [].
// No recency/domain params exist on this endpoint, so filters stay unsent.
// Native JSON-RPC over fetch; no MCP SDK dependency. One request, no retry.

import { fetchInit, safeResponseJson } from './http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from './web-search-types.js';

export const PARALLEL_MCP_ENDPOINT = 'https://search.parallel.ai/mcp';
export const PARALLEL_MCP_RESULT_MAX = 20;

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
    .join(' ')
    .trim()
    .slice(0, WEB_GENERATED_TEXT_MAX_CHARS);
}

/** Accept an array of rows, or an object envelope carrying a results array. */
function asRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const results = (value as Record<string, unknown>).results;
    if (Array.isArray(results)) return results;
  }
  return undefined;
}

/** Parse labeled-text fallback blocks: blank-line separated, Title:/URL:/Text:. */
export function parseLabeledTextResults(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const url = /^URL:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const snippet = /^Text:\s*([\s\S]*)$/m.exec(block)?.[1]?.trim();
    if (url === undefined) continue;
    rows.push({
      ...(title !== undefined ? { title } : {}),
      url,
      ...(snippet !== undefined ? { excerpts: [snippet] } : {}),
    });
  }
  return rows;
}

function extractJsonRpcRows(data: unknown): unknown[] | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const envelope = data as Record<string, unknown>;
  if (envelope.error !== undefined) return undefined;
  const result = envelope.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const resultRecord = result as Record<string, unknown>;
  // Encoding 1: native structuredContent.
  if (resultRecord.structuredContent !== undefined) {
    const rows = asRows(resultRecord.structuredContent);
    if (rows !== undefined) return rows;
  }
  // Encoding 2: JSON text blocks inside content[].
  if (Array.isArray(resultRecord.content)) {
    for (const entry of resultRecord.content as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(text);
        const rows = asRows(parsed);
        if (rows !== undefined) return rows;
      } catch {
        continue;
      }
    }
    // Encoding 3: labeled-text fallback from the same text blocks.
    for (const entry of resultRecord.content as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text !== 'string') continue;
      const rows = parseLabeledTextResults(text);
      if (rows.length > 0) return rows;
    }
    return undefined;
  }
  // Encoding 1b: bare results array directly on result.
  return asRows(resultRecord.results !== undefined ? resultRecord : undefined);
}

export const parallelMcpSearchAdapter: WebSearchAdapter = {
  id: 'parallel-mcp',
  configured(_env: Record<string, string | undefined>): boolean {
    return true;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const apiKey = input.env.PARALLEL_API_KEY?.trim() || undefined;
    const maxResults = Math.min(Math.max(Math.floor(input.limit), 1), PARALLEL_MCP_RESULT_MAX);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
    // Deadline comes from the runtime-composed policy signal (already bounded
    // by PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS). Pass it through unwrapped; only
    // standalone calls without a signal get the bounded fetchInit default.
    const validated = fetchInit(headers, undefined);
    const response = await fetch(PARALLEL_MCP_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search',
          arguments: { objective: input.query, search_queries: [input.query] },
        },
      }),
      ...validated,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect rejected for parallel-mcp search');
    }
    if (!response.ok) throw new Error(`Parallel MCP search failed with HTTP ${response.status}`);
    const data = await safeResponseJson(response, PARALLEL_MCP_ENDPOINT);
    const rows = extractJsonRpcRows(data);
    if (rows === undefined) throw new Error('Parallel MCP search returned an invalid response');
    const hits: WebSearchHit[] = [];
    for (const row of rows.slice(0, maxResults)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const url = stringField(record.url, '');
      if (!isHttpUrl(url)) continue;
      hits.push({
        title: stringField(record.title, 'Untitled').slice(0, TITLE_MAX_CHARS),
        url,
        snippet: excerptsText(record.excerpts),
        backend: 'parallel-mcp',
      });
    }
    return { backend: 'parallel-mcp', hits, generatedText: [] };
  },
};
