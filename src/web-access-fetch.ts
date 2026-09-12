// Pi Web Access v0.29 additive-parity ingestion: URL content fetching.
//
// Supports `url | urls` arrays in readable/raw modes. GitHub/media URLs route
// through the injected GitHub/media reader first (separate local tools are
// never modified); everything else uses the guarded page reader. No PDF
// parser, no proxy, no auth profiles, no shell. Retrieval slices reuse the
// existing Northstar maximum (50k chars). When `allowExternal` is false, no
// reader is called (explicit external-fetch gate).

import {
  WEB_ACCESS_MAX_FETCH_URLS,
  WEB_ACCESS_MAX_URL_LENGTH,
  WEB_ACCESS_RETRIEVAL_MAX_CHARS,
  WebAccessContractError,
  type WebAccessGithubMediaReader,
  type WebAccessPageReader,
} from './web-access-contract.js';
import { extractWebAccessPdfText, isPdfUrl, type WebAccessPdfExtractor } from './web-access-pdf.js';

export type WebAccessFetchMode = 'readable' | 'raw';

export interface WebAccessFetchInput {
  url?: unknown;
  urls?: unknown;
}

export interface WebAccessFetchOptions {
  mode?: WebAccessFetchMode | undefined;
  pageReader: WebAccessPageReader;
  githubMediaReader?: WebAccessGithubMediaReader | undefined;
  /** Injected feed (RSS/Atom) reader; tried before the generic page reader. */
  feedReader?: WebAccessGithubMediaReader | undefined;
  /** Raw PDF bytes for URLs whose format is inferred as PDF internally. */
  fetchPdfBytes?: ((url: string, signal?: AbortSignal) => Promise<Uint8Array>) | undefined;
  /** Local PDF extractor (unpdf-compatible); absent means page-reader fallback. */
  pdfExtractor?: WebAccessPdfExtractor | undefined;
  allowExternal?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface WebAccessFetchedPage {
  url: string;
  title: string;
  content: string;
  mode: WebAccessFetchMode;
  source: 'github-media' | 'feed' | 'pdf' | 'page' | 'blocked';
  truncated: boolean;
  error?: string | undefined;
}

function normalizeUrls(input: WebAccessFetchInput): string[] {
  const raw = input.urls !== undefined ? input.urls : input.url;
  if (raw === undefined) throw new WebAccessContractError('fetch requires url or urls');
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length < 1 || list.length > WEB_ACCESS_MAX_FETCH_URLS) {
    throw new WebAccessContractError(`urls must contain 1-${WEB_ACCESS_MAX_FETCH_URLS} entries`);
  }
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new WebAccessContractError('urls entries must be non-empty strings');
    }
    const url = entry.trim();
    if (url.length > WEB_ACCESS_MAX_URL_LENGTH) {
      throw new WebAccessContractError(`url exceeds maximum length of ${WEB_ACCESS_MAX_URL_LENGTH}`);
    }
    out.push(url);
  }
  return out;
}

function sliceContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= WEB_ACCESS_RETRIEVAL_MAX_CHARS) return { content, truncated: false };
  return { content: content.slice(0, WEB_ACCESS_RETRIEVAL_MAX_CHARS), truncated: true };
}

export async function fetchWebAccessContent(
  input: WebAccessFetchInput,
  options: WebAccessFetchOptions,
): Promise<WebAccessFetchedPage[]> {
  const urls = normalizeUrls(input);
  const mode: WebAccessFetchMode = options.mode ?? 'readable';
  if (mode !== 'readable' && mode !== 'raw') {
    throw new WebAccessContractError('mode must be "readable" or "raw"');
  }
  const out: WebAccessFetchedPage[] = [];
  for (const url of urls) {
    if (options.allowExternal === false) {
      out.push({ url, title: '', content: '', mode, source: 'blocked', truncated: false, error: 'external fetch is disabled' });
      continue;
    }
    try {
      const routed = await options.githubMediaReader?.read(url, options.signal);
      if (routed) {
        const sliced = sliceContent(routed.content);
        out.push({ url, title: routed.title, content: sliced.content, mode, source: 'github-media', truncated: sliced.truncated });
        continue;
      }
      const feed = await options.feedReader?.read(url, options.signal);
      if (feed) {
        const sliced = sliceContent(feed.content);
        out.push({ url, title: feed.title, content: sliced.content, mode, source: 'feed', truncated: sliced.truncated });
        continue;
      }
      if (isPdfUrl(url) && options.fetchPdfBytes && options.pdfExtractor) {
        const bytes = await options.fetchPdfBytes(url, options.signal);
        const pdf = await extractWebAccessPdfText(bytes, { extractor: options.pdfExtractor, signal: options.signal });
        const sliced = sliceContent(pdf.text);
        out.push({ url, title: url.split('/').pop() ?? url, content: sliced.content, mode, source: 'pdf', truncated: sliced.truncated || pdf.truncated });
        continue;
      }
      const page = await options.pageReader.read(url, mode, options.signal);
      const sliced = sliceContent(page.content);
      out.push({ url, title: page.title, content: sliced.content, mode, source: 'page', truncated: sliced.truncated });
    } catch (error) {
      out.push({
        url, title: '', content: '', mode, source: 'page', truncated: false,
        error: error instanceof Error ? error.message.slice(0, 500) : 'fetch failed',
      });
    }
  }
  return out;
}
