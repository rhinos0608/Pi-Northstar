import type { BackendCallResult } from '../backend.js';
import { callGraphTool } from '../graph/graph-tools.js';
import type { GraphError, GraphResult } from '../graph/graph-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export const GRAPH_SCHEMA_COMMAND = 'graph.schema';

function retryable(code: string): boolean {
  return code === 'rate_limited' || code === 'upstream_error';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error';
}

function graphEnvelope(result: BackendCallResult): GraphResult | undefined {
  return (result.details as Record<string, unknown> | undefined)?.graph as GraphResult | undefined;
}

export function mapGraphSchemaCommandResult(
  envelope: GraphResult,
  context: CommandContext,
): NorthstarCommandResultV1 {
  const outcome = envelope.status === 'ok' ? 'success'
    : envelope.status === 'empty' ? 'empty'
    : envelope.status === 'partial' ? 'partial'
    : 'failed';
  const firstError: GraphError | undefined = envelope.errors[0];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: GRAPH_SCHEMA_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: [{ kind: 'external', name: envelope.source.provider }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: GRAPH_SCHEMA_COMMAND,
    attemptedSurfaces: [context.surface, GRAPH_SCHEMA_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? { error: { code: firstError.code, message: firstError.message, retryable: firstError.retryable, category: 'graph' } }
      : {}),
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  return mapped;
}

function attachFailure(error: unknown, context: CommandContext): never {
  const code = context.signal?.aborted || (error instanceof Error && error.name === 'AbortError')
    ? 'cancelled'
    : errorCode(error);
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: GRAPH_SCHEMA_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable(code) ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: 'graph' }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: GRAPH_SCHEMA_COMMAND,
    attemptedSurfaces: [context.surface, GRAPH_SCHEMA_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'Graph schema request failed',
      retryable: retryable(code),
      category: code === 'cancelled' ? 'cancelled' : 'graph',
    },
  };
  const target = error instanceof Error ? error : new Error('Graph schema request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}
export async function executeGraphSchema(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (args.action !== undefined && args.action !== 'schema') {
      return attachFailure(Object.assign(new Error('action must be "schema" for graph.schema'), { code: 'invalid_input' }), context);
    }
    const { action: _ignored, ...rest } = args;
    const result = await callGraphTool({ action: 'schema', ...rest }, {
      env: context.env,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const envelope = graphEnvelope(result);
    if (!envelope) return attachFailure(new Error('Graph schema returned no envelope'), context);
    const northstarCommand = mapGraphSchemaCommandResult(envelope, context);
    return {
      ...result,
      details: {
        ...((result.details as Record<string, unknown> | undefined) ?? {}),
        northstarCommand,
      },
    };
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const graphSchemaHandler = { commandId: GRAPH_SCHEMA_COMMAND, execute: executeGraphSchema };
