import type { BackendCallResult } from '../backend.js';
import { textResult } from '../core/tool-output.js';
import { wrapUntrustedText } from '../core/untrusted-content.js';
import { DIFFBOT_KG_PROVIDER, enhanceDiffbotKg } from '../diffbot/diffbot-kg.js';
import { assembleKgEnhanceResult, resolveKgSpend, runKgProviderPlan } from '../knowledge/knowledge-execution.js';
import {
  buildKnowledgeResult,
  validateKgEnhance,
  type KgError,
  type KgResult,
} from '../knowledge/knowledge-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export const KG_ENHANCE_COMMAND = 'kg.enhance';

function retryable(code: string): boolean {
  return code === 'transport_invalid_response' || code === 'upstream_error';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'internal_error';
}

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

const ENHANCE_ARG_KEYS = new Set([
  'action', 'type', 'id', 'name', 'url', 'email', 'phone', 'location', 'description',
  'employer', 'title', 'school', 'fields', 'maxEntities',
  'includeRelationships', 'includeEvidence', 'confidenceThreshold',
]);

/**
 * Strict argument gate (reject-not-clamp). Only contract-owned enhance keys
 * pass through; unknown keys reject. Bounds (maxEntities 1..10,
 * confidenceThreshold 0..1) come from the owning validator, never clamped.
 * Reads only: no refresh/search/filter native options exist in this slice.
 */
function parseArgs(args: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(args)) {
    if (!ENHANCE_ARG_KEYS.has(key)) throw invalidInput(`unknown kg.enhance field: ${key}`);
  }
  if (args.action !== undefined && args.action !== 'enhance') {
    throw invalidInput('action must be "enhance" for kg.enhance');
  }
  const { action: _ignored, ...input } = args;
  const validated = validateKgEnhance(input);
  if (!validated.ok) throw Object.assign(new Error(validated.message), { code: validated.code });
  return input;
}

function commandSources(envelope: KgResult): NorthstarCommandResultV1['sources'] {
  const names = envelope.sources.map((entry) => entry.provider);
  const unique = [...new Set(names.length > 0 ? names : [DIFFBOT_KG_PROVIDER])];
  return unique.map((name) => ({ kind: 'external' as const, name }));
}

export function mapKgEnhanceCommandResult(envelope: KgResult, context: CommandContext): NorthstarCommandResultV1 {
  const outcome = envelope.status === 'ok' ? 'success'
    : envelope.status === 'empty' ? 'empty'
    : envelope.status === 'partial' ? 'partial'
    : envelope.status === 'degraded' ? 'degraded' : 'failed';
  const firstError: KgError | undefined = envelope.errors[0];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1', version: 1, commandId: KG_ENHANCE_COMMAND,
    invocationId: context.invocationId, outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: commandSources(envelope), trust: 'external',
    requestedSurface: context.surface, resolvedSurface: KG_ENHANCE_COMMAND,
    attemptedSurfaces: [context.surface, KG_ENHANCE_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' }, verifiedArtifacts: [], nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? { error: { code: firstError.code, message: firstError.message, retryable: firstError.retryable, category: 'kg' } }
      : {}),
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  return mapped;
}

function attachFailure(error: unknown, context: CommandContext): never {
  const code = context.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' : errorCode(error);
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1', version: 1, commandId: KG_ENHANCE_COMMAND,
    invocationId: context.invocationId, outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable(code) ? 'retryable' : 'not_retryable', data: null,
    sources: [{ kind: 'external', name: DIFFBOT_KG_PROVIDER }], trust: 'external',
    requestedSurface: context.surface, resolvedSurface: KG_ENHANCE_COMMAND,
    attemptedSurfaces: [context.surface, KG_ENHANCE_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' }, verifiedArtifacts: [], nextActions: [],
    error: { code, message: error instanceof Error ? error.message : 'KG enhance request failed', retryable: retryable(code), category: code === 'cancelled' ? 'cancelled' : 'kg' },
  };
  const target = error instanceof Error ? error : new Error('KG enhance request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

function isEmailLocalChar(char: string): boolean {
  return /[A-Za-z0-9._%+-]/.test(char);
}

function isEmailDomainChar(char: string): boolean {
  return /[A-Za-z0-9.-]/.test(char);
}

function redactEmbeddedEmails(label: string): string {
  let output = '';
  let cursor = 0;

  for (let at = label.indexOf('@'); at !== -1; at = label.indexOf('@', at + 1)) {
    let start = at;
    while (start > cursor && isEmailLocalChar(label[start - 1]!)) start--;
    let end = at + 1;
    while (end < label.length && isEmailDomainChar(label[end]!)) end++;

    const domain = label.slice(at + 1, end);
    const lastDot = domain.lastIndexOf('.');
    const tld = lastDot >= 0 ? domain.slice(lastDot + 1) : '';
    if (start === at || lastDot <= 0 || tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) continue;

    output += label.slice(cursor, start) + '[REDACTED_EMAIL]';
    cursor = end;
    at = end - 1;
  }

  return output + label.slice(cursor);
}

/**
 * Email/phone enhance selectors are PII: never echo them into user-facing
 * text. Name/id/url labels pass through verbatim; only an embedded email is
 * scrubbed there.
 */
function redactSelectorLabel(label: string, fromSensitiveSelector: boolean): string {
  const noEmail = redactEmbeddedEmails(label);
  if (!fromSensitiveSelector) return noEmail;
  return noEmail.replace(/\+?\d[\d\s().-]{6,30}\d/g, '[REDACTED_PHONE]');
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function executeKgEnhance(args: Record<string, unknown>, context: CommandContext): Promise<BackendCallResult> {
  let input: Record<string, unknown>;
  try {
    input = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }
  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const spend = resolveKgSpend(context.env);
    const token = typeof context.env.DIFFBOT_TOKEN === 'string' ? context.env.DIFFBOT_TOKEN.trim() : '';
    const configured = [DIFFBOT_KG_PROVIDER];
    const { outcomes, providers } = await runKgProviderPlan('enhance', undefined, configured, spend.maxProviders, async () => {
      const raw = await enhanceDiffbotKg(input, { token, spend: { enhanceDefault: spend.enhanceSize, enhanceCap: spend.enhanceSize }, ...(context.signal ? { signal: context.signal } : {}) });
      return raw.error
        ? { provider: raw.provider, entities: raw.entities, invalid: raw.invalid, error: { code: raw.error.code, message: raw.error.message, retryable: raw.error.retryable }, signals: raw.signals, claims: raw.claims, evidence: raw.evidence }
        : { provider: raw.provider, entities: raw.entities, invalid: raw.invalid, signals: raw.signals, claims: raw.claims, evidence: raw.evidence };
    });
    const assembled = assembleKgEnhanceResult(
      outcomes,
      typeof input.maxEntities === 'number' ? { maxEntities: input.maxEntities } : {},
    );
    const { entities, claims, conflicts, partitions, groups, evidence } = assembled;
    const envelope = buildKnowledgeResult({ request: { tool: 'kg', action: 'enhance', providers }, outcomes, data: { kind: 'enhance', entities, claims, conflicts, partitions, groups, evidence } });
    const northstarCommand = mapKgEnhanceCommandResult(envelope, context);
    const emailSelector = trimmedString(args.email);
    const phoneSelector = emailSelector === undefined ? trimmedString(args.phone) : undefined;
    const rawLabel = trimmedString(args.name) ?? trimmedString(args.id) ?? trimmedString(args.url)
      ?? emailSelector ?? phoneSelector ?? 'selectors';
    const label = redactSelectorLabel(rawLabel, rawLabel === emailSelector || rawLabel === phoneSelector);
    const text = entities.length > 0
      ? entities.map((entity, index) => `## ${index + 1}. ${entity.name ?? entity.id}\n${entity.url ?? entity.id}\ntype: ${entity.type}`).join('\n\n')
      : envelope.errors.length > 0
        ? `Kg enhance error (${envelope.errors[0]?.provider ?? DIFFBOT_KG_PROVIDER}): ${envelope.errors[0]?.message ?? 'unknown'}`
        : `No kg enhance results for: ${label}`;
    const result = textResult(wrapUntrustedText(text, { source: 'kg' }), {
      action: 'enhance', providers, knowledge: envelope,
    });
    (result.details as Record<string, unknown>).northstarCommand = northstarCommand;
    return result;
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const kgEnhanceHandler = { commandId: KG_ENHANCE_COMMAND, execute: executeKgEnhance };
