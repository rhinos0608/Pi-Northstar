import type { BackendCallResult } from '../backend.js';
import { DIFFBOT_KG_PROVIDER } from '../diffbot/diffbot-kg.js';
import type { KgError, KgResult } from '../knowledge/knowledge-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export const KG_NATIVE_COMMAND = 'kg.native';

function envelopeOf(result: BackendCallResult): KgResult | undefined {
  return (result.details as Record<string, unknown> | undefined)?.knowledge as KgResult | undefined;
}

function retryable(code: string): boolean {
  return code === 'transport_invalid_response' || code === 'upstream_error' || code === 'rate_limited';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error';
}

function sourcesOf(envelope: KgResult): NorthstarCommandResultV1['sources'] {
  const names = [...new Set(envelope.sources.map((entry) => entry.provider))];
  return (names.length > 0 ? names : [DIFFBOT_KG_PROVIDER]).map((name) => ({ kind: 'external' as const, name }));
}
export function mapKgNativeCommandResult(envelope: KgResult, context: CommandContext): NorthstarCommandResultV1 {
  const outcome = envelope.status === 'ok' ? 'success'
    : envelope.status === 'empty' ? 'empty'
    : envelope.status === 'partial' ? 'partial'
    : envelope.status === 'degraded' ? 'degraded'
    : 'failed';
  const firstError: KgError | undefined = envelope.errors[0];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: KG_NATIVE_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: sourcesOf(envelope),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: KG_NATIVE_COMMAND,
    attemptedSurfaces: [context.surface, KG_NATIVE_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? { error: { code: firstError.code, message: firstError.message, retryable: firstError.retryable, category: 'kg' } }
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
    commandId: KG_NATIVE_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable(code) ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: DIFFBOT_KG_PROVIDER }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: KG_NATIVE_COMMAND,
    attemptedSurfaces: [context.surface, KG_NATIVE_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'KG request failed',
      retryable: retryable(code),
      category: code === 'cancelled' ? 'cancelled' : 'kg',
    },
  };
  const target = error instanceof Error ? error : new Error('KG request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}
export async function executeKgNative(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    // Deliberately dynamic: native-tools imports the command registry. Loading it
    // only after registry initialization avoids a module-init cycle while the
    // worker retains its isolated environment/credential boundary.
    const { callNativeKgTool } = await import('../native-tools.js');
    const result = await callNativeKgTool(args, {
      env: context.env,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const envelope = envelopeOf(result);
    if (!envelope) return attachFailure(new Error('KG runtime returned no canonical envelope'), context);
    const northstarCommand = mapKgNativeCommandResult(envelope, context);
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

export const kgNativeHandler = { commandId: KG_NATIVE_COMMAND, execute: executeKgNative };
