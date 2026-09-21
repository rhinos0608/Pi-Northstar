import type { NorthstarResultV1 } from '../result-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export interface ExternalCommandMapOptions {
  commandId: string;
  category: string;
  fallbackSource: string;
}

export interface ExternalFailureOptions extends ExternalCommandMapOptions {
  source?: string;
  failureMessage: string;
  retryable?: (error: unknown, code: string) => boolean;
}

export function commandFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function commandErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error';
}

export function commandBackendName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { backend?: unknown }).backend === 'string'
    ? (error as { backend: string }).backend
    : undefined;
}

export function cleanCommandString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function isTransientBackendCode(code: string): boolean {
  return code === 'rate_limited'
    || code === 'backend_unavailable'
    || code === 'upstream_error'
    || code === 'malformed_upstream'
    || code === 'timeout';
}

function mapOutcome(status: NorthstarResultV1['status']): NorthstarCommandResultV1['outcome'] {
  if (status === 'ok') return 'success';
  if (status === 'empty') return 'empty';
  if (status === 'partial') return 'partial';
  if (status === 'degraded') return 'degraded';
  return 'failed';
}

function commandSources(envelope: NorthstarResultV1, fallbackSource: string): NorthstarCommandResultV1['sources'] {
  const names = envelope.sources.map((entry) => entry.source);
  const requestFallback = envelope.request.source || envelope.request.channel || fallbackSource;
  return [...new Set(names.length > 0 ? names : [requestFallback])]
    .map((name) => ({ kind: 'external' as const, name }));
}

function validated(result: NorthstarCommandResultV1): NorthstarCommandResultV1 {
  const check = validateCommandResult(result);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  return result;
}

export function mapExternalCommandResult(
  envelope: NorthstarResultV1,
  context: CommandContext,
  options: ExternalCommandMapOptions,
): NorthstarCommandResultV1 {
  const outcome = mapOutcome(envelope.status);
  const firstError = envelope.errors[0];
  return validated({
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: options.commandId,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: commandSources(envelope, options.fallbackSource),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: options.commandId,
    attemptedSurfaces: [context.surface, options.commandId],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? { error: { code: firstError.code, message: firstError.message, retryable: firstError.retryable, category: options.category } }
      : {}),
  });
}

export function attachExternalCommandFailure(
  error: unknown,
  context: CommandContext,
  options: ExternalFailureOptions,
): never {
  const cancelled = context.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
  const code = cancelled ? 'cancelled' : commandErrorCode(error);
  const retryable = cancelled ? false : (options.retryable?.(error, code) ?? isTransientBackendCode(code));
  const mapped = validated({
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: options.commandId,
    invocationId: context.invocationId,
    outcome: cancelled ? 'cancelled' : 'failed',
    retryability: retryable ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: commandBackendName(error) ?? options.source ?? options.fallbackSource }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: options.commandId,
    attemptedSurfaces: [context.surface, options.commandId],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : options.failureMessage,
      retryable,
      category: cancelled ? 'cancelled' : options.category,
    },
  });
  const target = error instanceof Error ? error : new Error(options.failureMessage);
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}
