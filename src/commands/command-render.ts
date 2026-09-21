import { wrapUntrustedText } from '../core/untrusted-content.js';
import { COMMAND_RESULT_MAX_RENDERED_BYTES, parseCommandResult, type NorthstarCommandResultV1 } from './command-result.js';

function externalize(value: unknown, source: string): unknown {
  if (typeof value === 'string') return wrapUntrustedText(value, { source });
  if (Array.isArray(value)) return value.map((item) => externalize(item, source));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, externalize(item, source)]));
  return value;
}
function bounded(output: string): string {
  if (new TextEncoder().encode(output).byteLength > COMMAND_RESULT_MAX_RENDERED_BYTES) throw new Error('rendered command result exceeds maximum bytes');
  return output;
}
export function renderCommandJson(result: NorthstarCommandResultV1): string {
  return bounded(JSON.stringify(parseCommandResult(result)));
}
export function renderCommandHuman(result: NorthstarCommandResultV1): string {
  const checked = parseCommandResult(result);
  const lines = [`${checked.commandId}: ${checked.outcome}`, `invocation=${checked.invocationId} trust=${checked.trust} retry=${checked.retryability}`];
  if (checked.error) lines.push(`error ${checked.error.code}: ${checked.error.message}`);
  if (checked.sources.length > 0) lines.push(`sources: ${checked.sources.map((source) => `${source.kind}:${source.name}`).join(', ')}`);
  if (checked.outcome === 'success' || checked.outcome === 'partial' || checked.outcome === 'degraded') {
    const body = typeof checked.data === 'string' ? checked.data : JSON.stringify(checked.data);
    if (body !== undefined && body !== '') lines.push(checked.trust === 'internal' ? body : `external evidence:\n${wrapUntrustedText(body, { source: 'command-result' })}`);
  }
  return bounded(lines.join('\n'));
}
export function renderCommandAgent(result: NorthstarCommandResultV1): string {
  const checked = parseCommandResult(result);
  const data = checked.trust === 'internal' ? checked.data : externalize(checked.data, checked.sources.find((s) => s.kind === 'external')?.name ?? 'command-result');
  return bounded(JSON.stringify({ schema: checked.schema, version: checked.version, commandId: checked.commandId, invocationId: checked.invocationId, outcome: checked.outcome, retryability: checked.retryability, trust: checked.trust, requestedSurface: checked.requestedSurface, resolvedSurface: checked.resolvedSurface, attemptedSurfaces: checked.attemptedSurfaces, sideEffect: checked.sideEffect, sources: checked.sources, ...(checked.error === undefined ? {} : { error: checked.error }), data, nextActions: checked.nextActions, verifiedArtifacts: checked.verifiedArtifacts }));
}
export type CommandRenderMode = 'human' | 'json' | 'agent';
export function renderCommandResult(result: NorthstarCommandResultV1, mode: CommandRenderMode): string { if (mode === 'human') return renderCommandHuman(result); if (mode === 'json') return renderCommandJson(result); return renderCommandAgent(result); }
export const renderCommandResultHuman = renderCommandHuman;
export const renderCommandResultJson = renderCommandJson;
export const renderCommandResultAgent = renderCommandAgent;
