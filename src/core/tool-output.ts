import type { BackendCallResult } from '../backend.js';
import type { NorthstarRequestV1, NorthstarResultV1 } from '../result-contract.js';
import { buildNorthstarResult, validateNorthstarResult } from '../result-contract.js';
import { normalizeUrl } from '../search/fusion.js';

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 60_000;
const MIN_MAX_TOOL_OUTPUT_CHARS = 1_000;
const HEAD_RATIO = 0.8;

export interface GuardOptions {
  maxChars?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export function maxToolOutputChars(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_SEARCH_MAX_TOOL_OUTPUT_CHARS?.trim();
  if (!raw) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  return Math.max(Math.trunc(parsed), MIN_MAX_TOOL_OUTPUT_CHARS);
}

export function guardText(text: string, options: GuardOptions = {}): string {
  const maxChars = options.maxChars !== undefined
    ? Math.max(Math.trunc(options.maxChars), MIN_MAX_TOOL_OUTPUT_CHARS)
    : maxToolOutputChars(options.env ?? process.env);
  if (text.length <= maxChars) return text;

  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = maxChars - headChars;
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n[context guard: output truncated, ${omitted} of ${text.length} chars omitted]\n\n${text.slice(-tailChars)}`;
}

export function guardResult(result: BackendCallResult, options: GuardOptions = {}): BackendCallResult {
  if (!Array.isArray(result.content)) return result;
  const content = result.content.map((item) =>
    isTextContent(item) ? { ...item, text: guardText(item.text, options) } : item,
  );
  return { ...result, content };
}

export function dedupeBy<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
  mergeFn: (current: T, candidate: T) => T = (current) => current,
): T[] {
  const byKey = new Map<string, number>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (key) {
      const at = byKey.get(key);
      if (at !== undefined) {
        deduped[at] = mergeFn(deduped[at] as T, item);
        continue;
      }
      byKey.set(key, deduped.length);
    }
    deduped.push(item);
  }
  return deduped;
}

export function dedupeByUrl<T extends { url: string }>(
  items: readonly T[],
  mergeFn?: (current: T, candidate: T) => T,
): T[] {
  return dedupeBy(items, (item) => (item.url ? normalizeUrl(item.url) : ''), mergeFn);
}

export function textResult(text: string, details: unknown, options: GuardOptions = {}): BackendCallResult {
  return { content: [{ type: 'text', text: guardText(text, options) }], details };
}

export function jsonTextResult(data: unknown, options: GuardOptions = {}): BackendCallResult {
  return textResult(JSON.stringify(data, null, 2) ?? String(data), data, options);
}

/**
 * Attach the canonical V1 result under `details.northstar` while preserving
 * every legacy detail field (platform/action/backend/items/...). Never
 * destructive: legacy observable keys keep their requested values.
 */
export function withNorthstarDetails(
  details: Record<string, unknown> | undefined,
  northstar: NorthstarResultV1,
): Record<string, unknown> {
  return { ...(details ?? {}), northstar };
}

/**
 * Build a guarded text result whose details carry the legacy payload plus the
 * canonical `northstar` envelope under its own key.
 *
 * Fail-closed: the envelope is semantically validated before it is attached.
 * A malformed envelope is never surfaced; it is replaced by a safe error
 * envelope (status `error`, code `invalid_backend_response`) with a sanitized
 * request. BackendCallResult shape is unchanged either way.
 */
export function northstarTextResult(
  text: string,
  legacyDetails: Record<string, unknown> | undefined,
  northstar: NorthstarResultV1,
  options: GuardOptions = {},
): BackendCallResult {
  const check = validateNorthstarResult(northstar);
  const envelope = check.ok ? northstar : failClosedEnvelope(northstar, check.issues);
  return textResult(text, withNorthstarDetails(legacyDetails, envelope), options);
}

/**
 * Replace a malformed canonical envelope with a minimal valid error envelope.
 * Request fields are sanitized so the replacement itself always validates.
 */
function failClosedEnvelope(original: NorthstarResultV1, issues: string[]): NorthstarResultV1 {
  const request = safeNorthstarRequest(original?.request);
  return buildNorthstarResult({
    request,
    outcomes: [{
      source: request.source ?? 'unknown',
      backend: 'native',
      error: {
        code: 'invalid_backend_response',
        message: 'Canonical result envelope failed validation; malformed data withheld.',
        retryable: false,
      },
    }],
    pagination: { supported: false, limit: 0, hasMore: false },
    notes: issues.slice(0, 10),
  });
}

function safeNorthstarRequest(value: unknown): NorthstarRequestV1 {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const field = (v: unknown) => (typeof v === 'string' && v.trim() ? v : 'unknown');
  const request: NorthstarRequestV1 = {
    tool: field(raw.tool),
    channel: field(raw.channel),
    action: field(raw.action),
  };
  if (typeof raw.source === 'string' && raw.source.trim()) request.source = raw.source;
  if (typeof raw.requestedAction === 'string' && raw.requestedAction.trim()) request.requestedAction = raw.requestedAction;
  return request;
}

function isTextContent(item: unknown): item is { type: 'text'; text: string } {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    'text' in item &&
    (item as { type: unknown }).type === 'text' &&
    typeof (item as { text: unknown }).text === 'string'
  );
}
