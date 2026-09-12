// DuckDuckGo web-search adapter (canonical WebSearchAdapter shape).
// Exact behavior extraction from the legacy inline adapter in src/web.ts:
// single HTML GET (no Instant Answer call, no retry), result__a/result__snippet
// pair parsing, uddg redirect decoding. Always configured (no credentials).

import { fetchText } from './http.js';
import type {
  WebProviderSearchInput,
  WebProviderSearchOutput,
  WebSearchAdapter,
  WebSearchHit,
} from './web-search-types.js';

export const DUCKDUCKGO_SEARCH_URL = 'https://duckduckgo.com/html/';

function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(html: string): string {
  return cleanText(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function decodeDuckDuckGoUrl(raw: string): string {
  const decoded = raw.replace(/&amp;/g, '&');
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') ?? url.href;
  } catch {
    return decoded;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const DUCKDUCKGO_ANCHOR_PATTERN =
  /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const DUCKDUCKGO_SNIPPET_PATTERN = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

export const duckduckgoSearchAdapter: WebSearchAdapter = {
  id: 'duckduckgo',
  configured(_env: Record<string, string | undefined>): boolean {
    return true;
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    const url = new URL(DUCKDUCKGO_SEARCH_URL);
    url.searchParams.set('q', input.query);
    const html = await fetchText(url.href, input.signal);
    const anchors = [...html.matchAll(DUCKDUCKGO_ANCHOR_PATTERN)];
    const hits: WebSearchHit[] = [];
    for (let index = 0; index < anchors.length; index++) {
      const match = anchors[index]!;
      const decodedUrl = decodeDuckDuckGoUrl(match[1] ?? '');
      if (!isHttpUrl(decodedUrl)) continue;
      const blockEnd = index + 1 < anchors.length ? (anchors[index + 1]!.index ?? html.length) : html.length;
      const block = html.slice((match.index ?? 0) + match[0].length, blockEnd);
      const snippetMatch = DUCKDUCKGO_SNIPPET_PATTERN.exec(block);
      hits.push({
        title: stripHtml(match[2] ?? ''),
        url: decodedUrl,
        snippet: snippetMatch ? stripHtml(snippetMatch[1] ?? '') : '',
        backend: 'duckduckgo' as const,
      });
      if (hits.length >= input.limit) break;
    }
    return { backend: 'duckduckgo', hits, generatedText: [] };
  },
};
