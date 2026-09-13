import { validateHttpUrl } from '../core/http.js';
import { type DnsLookup, resolvePublicHostname } from '../network-policy.js';
import {
  DIFFBOT_API_HOST,
  DiffbotError,
  diffbotFetch,
  redactDiffbotError,
  resolveDiffbotSpend,
} from './diffbot-transport.js';

/** Fixed v1 Analyze fields: page text plus outbound links. */
export const DIFFBOT_ANALYZE_FIELDS = 'allContent,links';

/** Default per-fetch Analyze-GET budget; 0 disables. */
export const ANALYZE_FALLBACK_BUDGET_DEFAULT = 3;

/** Hard ceiling for the per-fetch Analyze-GET budget. */
export const ANALYZE_FALLBACK_BUDGET_MAX = 25;

export interface AnalyzePage {
  url: string;
  title: string;
  content: string;
  links?: string[];
}

export interface AnalyzePageOptions {
  token: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  lookup?: DnsLookup;
  budget?: AnalyzeBudget;
}

export interface AnalyzeBudget {
  readonly limit: number;
  readonly remaining: number;
  /** Consume one Analyze call. Returns false when exhausted (including zero limit). */
  tryConsume(): boolean;
}

/** Resolve DIFFBOT_FALLBACK_BUDGET via shared spend table: default 3, 0 disables, 0..25. Out-of-range throws, never clamps. */
export function resolveAnalyzeBudget(env: Record<string, string | undefined> = process.env): number {
  return resolveDiffbotSpend(env).fallbackBudget;
}

/** Per-fetch budget primitive counting Analyze-GET calls for one fetch invocation. */
export function createAnalyzeBudget(
  limit?: number,
  env: Record<string, string | undefined> = process.env,
): AnalyzeBudget {
  const resolved = limit ?? resolveAnalyzeBudget(env);
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > ANALYZE_FALLBACK_BUDGET_MAX) {
    throw new DiffbotError(
      'unsupported_option',
      `Analyze budget out of range: expected integer 0..${ANALYZE_FALLBACK_BUDGET_MAX}`,
    );
  }
  let remaining = resolved;
  return {
    limit: resolved,
    get remaining() {
      return remaining;
    },
    tryConsume(): boolean {
      if (remaining <= 0) return false;
      remaining -= 1;
      return true;
    },
  };
}

/**
 * Analyze-GET page fallback: validates the public target URL first, then
 * `GET {API_HOST}/v3/analyze?url=&fields=allContent,links&token=`.
 * Wired as the fetchReadablePage fallback in src/web.ts (shared per-fetch budget).
 */
export async function analyzePage(targetUrl: string, options: AnalyzePageOptions): Promise<AnalyzePage> {
  const { token, signal, timeoutMs, maxBytes, lookup, budget } = options;
  const validated = validateHttpUrl(targetUrl);
  await resolvePublicHostname(new URL(validated).hostname, signal, lookup);
  if (!token) {
    throw new DiffbotError('contract_invalid_response', 'DIFFBOT_TOKEN is not configured');
  }
  if (budget && !budget.tryConsume()) {
    throw new DiffbotError('unsupported_option', 'Diffbot Analyze budget exhausted for this fetch');
  }
  const parsed = await diffbotFetch<unknown>({
    host: DIFFBOT_API_HOST,
    path: '/v3/analyze',
    token,
    query: { url: validated, fields: DIFFBOT_ANALYZE_FIELDS },
    ...(signal !== undefined ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  return normalizeAnalyzePage(parsed, validated, token);
}

function normalizeAnalyzePage(parsed: unknown, validatedUrl: string, token: string): AnalyzePage {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DiffbotError(
      'contract_invalid_response',
      redactDiffbotError('Diffbot Analyze response violates contract: expected object with objects[]', token),
    );
  }
  const objects = (parsed as { objects?: unknown }).objects;
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new DiffbotError(
      'contract_invalid_response',
      redactDiffbotError('Diffbot Analyze response violates contract: objects[] is empty', token),
    );
  }
  const first = objects[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) {
    throw new DiffbotError(
      'contract_invalid_response',
      redactDiffbotError('Diffbot Analyze response violates contract: objects[0] is not an object', token),
    );
  }
  const record = first as Record<string, unknown>;
  const content = asText(record.text) || asText(record.allContent) || '';
  if (!content.trim()) {
    throw new DiffbotError(
      'semantic_invalid_response',
      redactDiffbotError('Diffbot Analyze response is unusable: empty page content', token),
    );
  }
  const title = asText(record.title) || asText(record.name) || '';
  const url = asText(record.pageUrl) || asText(record.resolvedPageUrl) || validatedUrl;
  const links = normalizeLinks(record.links);
  return {
    url,
    title: title.trim(),
    content: content.trim(),
    ...(links !== undefined ? { links } : {}),
  };
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeLinks(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim()) out.push(entry.trim());
    } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const href = asText(record.href) ?? asText(record.url) ?? asText(record.link);
      if (href) out.push(href.trim());
    }
  }
  return out;
}
