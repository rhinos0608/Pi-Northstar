// Environment-only native-AI policy plus generated-text normalization.
// Absent/blank means enabled. Generated text never replaces retrieval snippets;
// summaries carry result-URL provenance, answers carry supporting-result-set
// provenance with claimCitations always false.
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  WEB_GENERATED_TEXT_MAX_ITEMS,
  type WebGeneratedText,
} from './web-search-types.js';

export interface WebNativeAiPolicy {
  summaries: boolean;
  answers: boolean;
}

export function resolveWebNativeAiPolicy(env: Record<string, string | undefined>): WebNativeAiPolicy {
  return {
    summaries: parseNativeAiFlag(env['PI_SEARCH_NATIVE_SUMMARIES'], 'PI_SEARCH_NATIVE_SUMMARIES'),
    answers: parseNativeAiFlag(env['PI_SEARCH_NATIVE_ANSWERS'], 'PI_SEARCH_NATIVE_ANSWERS'),
  };
}

export function parseNativeAiFlag(raw: string | undefined, key: string): boolean {
  if (raw === undefined || raw.trim() === '') {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(`${key}: expected one of 1/true/0/false, got "${raw}"`);
}

/**
 * Normalize provider-generated text: drop empties (including answers without
 * supporting URLs), truncate items to 8,000 chars, dedupe, cap at 32 items.
 */
export function normalizeGeneratedText(items: readonly WebGeneratedText[]): WebGeneratedText[] {
  const out: WebGeneratedText[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (out.length >= WEB_GENERATED_TEXT_MAX_ITEMS) break;
    if (item.kind === 'summary') {
      const url = item.url.trim();
      const text = item.text.trim();
      if (url === '' || text === '') continue;
      const key = `summary|${item.backend}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'summary',
        backend: item.backend,
        url,
        text: text.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        provenance: { kind: 'result_url', urls: [url] },
        claimCitations: false,
      });
    } else {
      const text = item.text.trim();
      const urls = dedupeUrls(item.provenance.urls);
      if (text === '' || urls.length === 0) continue;
      const key = `answer|${item.backend}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'answer',
        backend: item.backend,
        text: text.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        provenance: { kind: 'supporting_result_set', urls },
        claimCitations: false,
      });
    }
  }
  return out;
}

function dedupeUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
