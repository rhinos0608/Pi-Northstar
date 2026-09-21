import type { BackendCallResult } from '../backend.js';
import { callGithubTool } from '../github/github-domain.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export const GITHUB_COMMITS_COMMAND = 'github.commits';

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
    const outcome = status === 'degraded' ? 'degraded' : status === 'partial' ? 'partial' : status === 'empty' ? 'empty' : 'success';
    const mapped: NorthstarCommandResultV1 = {
      schema: 'northstar.command-result.v1',
      version: 1,
      commandId,
      invocationId: context.invocationId,
      outcome,
      retryability: 'not_retryable',
      data: canonical?.data ?? details?.entities ?? details?.data ?? null,
      sources: [{ kind: 'external', name: source }],
      trust: 'external',
      requestedSurface: context.surface,
      resolvedSurface: commandId,
      attemptedSurfaces: [context.surface, commandId],
      sideEffect: { started: false, settled: true, outcome: 'not_started' },
      verifiedArtifacts: [],
      nextActions: [],
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

const bundle = createGithubCommandHandler({
  commandId: GITHUB_COMMITS_COMMAND,
  action: 'commits',
  failureMessage: 'GitHub commits request failed',
});

export const mapGithubCommitsCommandResult = bundle.mapResult;
export const executeGithubCommits = bundle.execute;
export const githubCommitsHandler = bundle.handler;
