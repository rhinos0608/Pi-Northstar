import type { BackendCallResult } from '../backend.js';
import { callGithubTool } from '../github/github-domain.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export interface CreateGithubCommandHandlerOptions {
  commandId: string;
  action: string;
  failureMessage: string;
}

export function createGithubCommandHandler(options: CreateGithubCommandHandlerOptions) {
  const { commandId, action, failureMessage } = options;

  function errorCode(error: unknown): string {
    return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'internal_error';
  }

  function retryable(code: string): boolean {
    return code === 'rate_limited' || code === 'upstream_error';
  }

  function parseCanonicalError(
    canonical: Record<string, unknown> | undefined,
  ): { code: string; message: string; retryable: boolean } | undefined {
    const errors = Array.isArray(canonical?.errors) ? (canonical.errors as Array<unknown>) : [];
    const first = errors.length > 0 && typeof errors[0] === 'object' && errors[0] !== null
      ? (errors[0] as Record<string, unknown>)
      : undefined;
    if (first === undefined) return undefined;
    const code = typeof first.code === 'string' && first.code.length > 0 ? first.code.slice(0, 256) : 'upstream_error';
    const message = typeof first.message === 'string' && first.message.length > 0
      ? first.message.slice(0, 4096)
      : failureMessage;
    return { code, message, retryable: first.retryable === true };
  }

  function mapResult(result: BackendCallResult, context: CommandContext): NorthstarCommandResultV1 {
    const details = result.details as Record<string, unknown> | undefined;
    const canonical = details?.northstar as Record<string, unknown> | undefined;
    const request = canonical?.request as Record<string, unknown> | undefined;
    const sources = canonical?.sources as Array<Record<string, unknown>> | undefined;
    const source = typeof request?.source === 'string'
      ? request.source
      : typeof sources?.[0]?.backend === 'string'
        ? sources[0].backend
        : 'github-api';
    const status = canonical?.status;
    const outcome = status === 'error'
      ? 'failed'
      : status === 'degraded' ? 'degraded' : status === 'partial' ? 'partial' : status === 'empty' ? 'empty' : 'success';
    const firstError = status === 'error' ? parseCanonicalError(canonical) : undefined;
    const mapped: NorthstarCommandResultV1 = {
      schema: 'northstar.command-result.v1',
      version: 1,
      commandId,
      invocationId: context.invocationId,
      outcome,
      retryability: firstError !== undefined && firstError.retryable ? 'retryable' : 'not_retryable',
      data: status === 'error' ? null : (canonical?.data ?? details?.entities ?? details?.data ?? null),
      sources: [{ kind: 'external', name: source }],
      trust: 'external',
      requestedSurface: context.surface,
      resolvedSurface: commandId,
      attemptedSurfaces: [context.surface, commandId],
      sideEffect: { started: false, settled: true, outcome: 'not_started' },
      verifiedArtifacts: [],
      nextActions: [],
      ...(firstError !== undefined ? { error: { ...firstError, category: 'github' } } : {}),
    };
    const check = validateCommandResult(mapped);
    if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
    return mapped;
  }

  function attachFailure(error: unknown, context: CommandContext): never {
    const code = context.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' : errorCode(error);
    const mapped: NorthstarCommandResultV1 = {
      schema: 'northstar.command-result.v1',
      version: 1,
      commandId,
      invocationId: context.invocationId,
      outcome: code === 'cancelled' ? 'cancelled' : 'failed',
      retryability: retryable(code) ? 'retryable' : 'not_retryable',
      data: null,
      sources: [{
        kind: 'external',
        name: typeof (error as { backend?: unknown })?.backend === 'string'
          ? (error as { backend: string }).backend
          : 'github-api',
      }],
      trust: 'external',
      requestedSurface: context.surface,
      resolvedSurface: commandId,
      attemptedSurfaces: [context.surface, commandId],
      sideEffect: { started: false, settled: true, outcome: 'not_started' },
      verifiedArtifacts: [],
      nextActions: [],
      error: {
        code,
        message: error instanceof Error ? error.message : failureMessage,
        retryable: retryable(code),
        category: code === 'cancelled' ? 'cancelled' : 'github',
      },
    };
    const target = error instanceof Error ? error : new Error(failureMessage);
    Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
    throw target;
  }

  async function execute(args: Record<string, unknown>, context: CommandContext): Promise<BackendCallResult> {
    try {
      const result = await callGithubTool(
        { ...args, action },
        { env: context.env, ...(context.signal ? { signal: context.signal } : {}) },
      );
      return {
        ...result,
        details: {
          ...((result.details as Record<string, unknown> | undefined) ?? {}),
          northstarCommand: mapResult(result, context),
        },
      };
    } catch (error) {
      return attachFailure(error, context);
    }
  }

  return {
    commandId,
    execute,
    mapResult,
    handler: { commandId, execute },
  };
}
