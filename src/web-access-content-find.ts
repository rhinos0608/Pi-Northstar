// Pi Web Access v0.29 additive-parity ingestion: stored-content retrieval.
//
// Upstream get_search_content semantics preserved where Phase 1 allows:
// - responseId lookup (memory only; no disk restore).
// - queryIndex/query/url/urlIndex/provider selectors narrow the text.
// - offset/limit character slices (bounded by retrieval max 50k).
// - findText (string or array) DISCARDS offset/limit, never rejects.
// - findMode exact | case-insensitive (default) | fuzzy; findMode without
//   findText rejects.

import {
  WEB_ACCESS_RETRIEVAL_MAX_CHARS,
  WebAccessContractError,
  normalizeWebAccessContentSlice,
  type WebAccessContentStore,
  type WebAccessProviderId,
  type WebAccessStoredEntry,
} from './web-access-contract.js';

export type WebAccessFindMode = 'exact' | 'case-insensitive' | 'fuzzy';

const FIND_MODES: readonly string[] = ['exact', 'case-insensitive', 'fuzzy'];

export interface WebAccessGetContentRequest {
  responseId: string;
  queryIndex?: number | undefined;
  query?: string | undefined;
  url?: string | undefined;
  urlIndex?: number | undefined;
  provider?: WebAccessProviderId | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  findText?: string | string[] | undefined;
  findMode?: WebAccessFindMode | undefined;
  caseSensitive?: boolean | undefined;
  fuzzy?: boolean | undefined;
}

export interface WebAccessContentMatch {
  query: string;
  index: number;
  excerpt: string;
}

export interface WebAccessContentResult {
  responseId: string;
  text: string;
  totalChars: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number | undefined;
  matches?: WebAccessContentMatch[] | undefined;
  findMode?: WebAccessFindMode | undefined;
}

function formatHit(hit: { title: string; url: string; snippet: string }): string {
  return `- ${hit.title} (${hit.url})\n  ${hit.snippet}`;
}

export function serializeWebAccessEntry(entry: WebAccessStoredEntry): string {
  const blocks: string[] = [];
  for (const result of entry.results) {
    const lines: string[] = [`Query[${result.queryIndex}]: ${result.query}`];
    if (result.response) {
      if (result.response.answer) lines.push(`Answer (${result.response.provider}): ${result.response.answer}`);
      for (const hit of result.response.results) lines.push(formatHit(hit));
      if (result.response.inlineContent) lines.push(`Content: ${result.response.inlineContent}`);
    } else if (result.error) {
      lines.push(`Error (${result.error.provider}/${result.error.kind}): ${result.error.message}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function collectUrls(entry: WebAccessStoredEntry): string[] {
  const urls: string[] = [];
  for (const result of entry.results) {
    for (const hit of result.response?.results ?? []) urls.push(hit.url);
  }
  return urls;
}

function selectText(entry: WebAccessStoredEntry, req: WebAccessGetContentRequest): string {
  let results = entry.results;
  if (req.queryIndex !== undefined) results = results.filter((r) => r.queryIndex === req.queryIndex);
  if (req.query !== undefined && req.query.trim().length > 0) {
    results = results.filter((r) => r.query === req.query);
  }
  if (req.provider !== undefined) {
    results = results.filter((r) => r.response?.provider === req.provider);
  }
  let text = serializeWebAccessEntry({ ...entry, results });
  if (req.url !== undefined && req.url.trim().length > 0) {
    const needle = req.url.trim();
    const hits: string[] = [];
    for (const result of results) {
      for (const hit of result.response?.results ?? []) {
        if (hit.url === needle) hits.push(formatHit(hit));
      }
      if (result.response?.inlineContent && result.response.results.some((h) => h.url === needle)) {
        hits.push(`Content: ${result.response.inlineContent}`);
      }
    }
    text = hits.length > 0 ? hits.join('\n') : '';
  } else if (req.urlIndex !== undefined) {
    const urls = collectUrls({ ...entry, results });
    const picked = urls[req.urlIndex];
    text = picked !== undefined ? selectText(entry, { ...req, url: picked, urlIndex: undefined }) : '';
  }
  return text;
}

function normalizeFindQueries(findText: string | string[]): string[] {
  const list = Array.isArray(findText) ? findText : [findText];
  const out = list.map((q) => (typeof q === 'string' ? q.trim() : '')).filter((q) => q.length > 0);
  if (out.length === 0) throw new WebAccessContractError('findText must contain at least one non-empty string');
  return out;
}

function resolveFindMode(req: WebAccessGetContentRequest): WebAccessFindMode {
  if (req.findMode !== undefined) {
    if (!FIND_MODES.includes(req.findMode)) {
      throw new WebAccessContractError('findMode must be one of: exact, case-insensitive, fuzzy');
    }
    return req.findMode;
  }
  if (req.fuzzy === true) return 'fuzzy';
  if (req.caseSensitive === true) return 'exact';
  return 'case-insensitive';
}

function findIndices(haystack: string, needle: string, mode: WebAccessFindMode): number[] {
  if (mode === 'exact') {
    const out: number[] = [];
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) return out;
      out.push(at);
      from = at + Math.max(1, needle.length);
    }
  }
  if (mode === 'case-insensitive') {
    const lowerHay = haystack.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    const out: number[] = [];
    let from = 0;
    for (;;) {
      const at = lowerHay.indexOf(lowerNeedle, from);
      if (at < 0) return out;
      out.push(at);
      from = at + Math.max(1, lowerNeedle.length);
    }
  }
  // Fuzzy: all whitespace-separated tokens appear in order (case-insensitive).
  const tokens = needle.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const lower = haystack.toLowerCase();
  let from = 0;
  const first: number[] = [];
  for (;;) {
    const at = lower.indexOf(tokens[0]!, from);
    if (at < 0) return first;
    let cursor = at + tokens[0]!.length;
    let ok = true;
    for (const token of tokens.slice(1)) {
      const next = lower.indexOf(token, cursor);
      if (next < 0) { ok = false; break; }
      cursor = next + token.length;
    }
    if (ok) first.push(at);
    from = at + 1;
    if (first.length >= 20) return first;
  }
}

function excerpt(haystack: string, index: number, needleLength: number): string {
  const start = Math.max(0, index - 200);
  const end = Math.min(haystack.length, index + needleLength + 200);
  return haystack.slice(start, end);
}

export function getWebAccessContent(
  store: WebAccessContentStore,
  req: WebAccessGetContentRequest,
): WebAccessContentResult {
  const entry = store.get(req.responseId);
  if (!entry) {
    throw new WebAccessContractError(
      `No stored results for responseId ${JSON.stringify(req.responseId)}. Use a responseId returned by search or fetch_content.`,
    );
  }
  if (req.findMode !== undefined && req.findText === undefined) {
    throw new WebAccessContractError('findMode requires findText; provide findText or omit findMode.');
  }
  const text = selectText(entry, req);
  if (req.findText !== undefined) {
    // Upstream semantic: offset/limit discarded when findText present.
    const queries = normalizeFindQueries(req.findText);
    const mode = resolveFindMode(req);
    const matches: WebAccessContentMatch[] = [];
    for (const query of queries) {
      for (const index of findIndices(text, query, mode)) {
        matches.push({ query, index, excerpt: excerpt(text, index, query.length) });
        if (matches.length >= 20) break;
      }
      if (matches.length >= 20) break;
    }
    const combined = matches.map((m) => m.excerpt).join('\n---\n');
    return {
      responseId: req.responseId,
      text: combined,
      totalChars: text.length,
      offset: 0,
      truncated: false,
      matches,
      findMode: mode,
    };
  }
  const slice = normalizeWebAccessContentSlice({ offset: req.offset, limit: req.limit });
  const offset = slice.offset ?? 0;
  const limit = slice.limit ?? WEB_ACCESS_RETRIEVAL_MAX_CHARS;
  if (offset > text.length) {
    throw new WebAccessContractError(
      `Offset ${offset} is out of range (0-${text.length}). Use an offset within that range.`,
    );
  }
  const end = Math.min(text.length, offset + limit);
  const truncated = end < text.length;
  const result: WebAccessContentResult = {
    responseId: req.responseId,
    text: text.slice(offset, end),
    totalChars: text.length,
    offset,
    truncated,
  };
  if (truncated) result.nextOffset = end;
  return result;
}
