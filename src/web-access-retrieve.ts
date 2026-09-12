// Pi Web Access FINAL retrieve: cached-corpus-only read.
//
// Reads exclusively from the bounded in-memory content store (1h TTL,
// 128 entries, 128 MiB). Never performs network I/O. responseId selects
// the stored entry; sourceIds optionally narrow to individual sources.
//
// Source identity: `s-<queryIndex>-<hitIndex>` (hitIndex is the position
// of the hit inside its query response). Passage-free: retrieve returns
// citation blocks, not passage spans (spans live in source_check).
// findText present discards offset/limit (never rejects).

import { createHash } from 'node:crypto';
import {
  WEB_ACCESS_RETRIEVAL_MAX_CHARS,
  WebAccessContractError,
  normalizeWebAccessContentSlice,
  type WebAccessContentStore,
} from './web-access-contract.js';

export interface WebAccessRetrieveRequest {
  responseId: string;
  sourceIds?: string[] | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  findText?: string | undefined;
}

export interface WebAccessRetrieveSource {
  sourceId: string;
  url: string;
  title: string;
  provider: string;
  content_hash: string;
}

export interface WebAccessRetrieveMatch {
  sourceId: string;
  index: number;
  excerpt: string;
}

export interface WebAccessRetrieveResult {
  responseId: string;
  text: string;
  totalChars: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number | undefined;
  sources: WebAccessRetrieveSource[];
  matches?: WebAccessRetrieveMatch[] | undefined;
}

interface CorpusSource {
  sourceId: string;
  url: string;
  title: string;
  provider: string;
  snippet: string;
  inlineContent?: string | undefined;
  answer?: string | undefined;
  queryIndex: number;
  query: string;
}

function hashCorpusSource(source: Pick<CorpusSource, 'title' | 'url' | 'snippet' | 'inlineContent'>): string {
  return `sha256:${createHash('sha256')
    .update(`${source.title}\n${source.url}\n${source.snippet}\n${source.inlineContent ?? ''}`, 'utf8')
    .digest('hex')}`;
}

function collectSources(store: WebAccessContentStore, responseId: string, sourceIds?: string[]): CorpusSource[] {
  const entry = store.get(responseId);
  if (!entry) {
    throw new WebAccessContractError(
      `No stored results for responseId ${JSON.stringify(responseId)}. ResponseIds expire after 1h; re-run search.`,
    );
  }
  const all: CorpusSource[] = [];
  for (const result of entry.results) {
    const hits = result.response?.results ?? [];
    hits.forEach((hit, hitIndex) => {
      all.push({
        sourceId: `s-${result.queryIndex}-${hitIndex}`,
        url: hit.url,
        title: hit.title,
        provider: result.response?.provider ?? 'unknown',
        snippet: hit.snippet,
        inlineContent: result.response?.inlineContent,
        answer: result.response?.answer,
        queryIndex: result.queryIndex,
        query: result.query,
      });
    });
  }
  if (sourceIds === undefined) return all;
  const wanted = new Set(sourceIds);
  const unknown = [...wanted].filter((id) => !all.some((s) => s.sourceId === id));
  if (unknown.length > 0) {
    throw new WebAccessContractError(`Unknown sourceIds for responseId ${JSON.stringify(responseId)}: ${unknown.join(', ')}`);
  }
  return all.filter((s) => wanted.has(s.sourceId));
}

function formatSource(source: CorpusSource): string {
  const lines = [`[${source.sourceId}] ${source.title} (${source.url}) [${hashCorpusSource(source)}]`];
  if (source.snippet.length > 0) lines.push(source.snippet);
  return lines.join('\n');
}

function serializeCorpus(sources: CorpusSource[]): string {
  const blocks: string[] = [];
  const queryOrder: number[] = [];
  for (const source of sources) {
    if (!queryOrder.includes(source.queryIndex)) queryOrder.push(source.queryIndex);
  }
  for (const queryIndex of queryOrder) {
    const group = sources.filter((s) => s.queryIndex === queryIndex);
    const head = group[0]!;
    const lines = [`Query[${queryIndex}]: ${head.query}`];
    if (head.answer) lines.push(`Answer (${head.provider}): ${head.answer}`);
    for (const source of group) lines.push(formatSource(source));
    const inline = head.inlineContent;
    if (inline) lines.push(`Content: ${inline}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function excerptAround(haystack: string, index: number, needleLength: number): string {
  return haystack.slice(Math.max(0, index - 200), Math.min(haystack.length, index + needleLength + 200));
}

export function retrieveWebAccessCorpus(
  store: WebAccessContentStore,
  req: WebAccessRetrieveRequest,
): WebAccessRetrieveResult {
  const sources = collectSources(store, req.responseId, req.sourceIds);
  const text = serializeCorpus(sources);
  const cited: WebAccessRetrieveSource[] = sources.map((s) => ({
    sourceId: s.sourceId,
    url: s.url,
    title: s.title,
    provider: s.provider,
    content_hash: hashCorpusSource(s),
  }));
  if (req.findText !== undefined) {
    if (typeof req.findText !== 'string' || req.findText.length === 0) {
      throw new WebAccessContractError('findText must be a non-empty string when provided');
    }
    // findText wins: offset/limit accepted but ignored.
    const needle = req.findText.toLowerCase();
    const lower = text.toLowerCase();
    const matches: WebAccessRetrieveMatch[] = [];
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0 || matches.length >= 20) break;
      const excerpt = excerptAround(text, at, req.findText.length);
      const owner = sources.find((s) => new RegExp(`${s.sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).test(excerpt))?.sourceId ?? sources[0]?.sourceId ?? '';
      matches.push({ sourceId: owner, index: at, excerpt });
      from = at + Math.max(1, needle.length);
    }
    return {
      responseId: req.responseId,
      text: matches.map((m) => m.excerpt).join('\n---\n'),
      totalChars: text.length,
      offset: 0,
      truncated: false,
      sources: cited,
      matches,
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
  const result: WebAccessRetrieveResult = {
    responseId: req.responseId,
    text: text.slice(offset, end),
    totalChars: text.length,
    offset,
    truncated,
    sources: cited,
  };
  if (truncated) result.nextOffset = end;
  return result;
}
