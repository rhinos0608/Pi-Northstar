import { northstarTextResult } from '../core/tool-output.js';
import { MAX_CURSOR_LENGTH } from '../result-contract.js';
import { fetchResearchCitations } from '../research/research-sources.js';
import type { NorthstarEntityV1, NorthstarResultV1 } from '../result-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import type { BackendCallResult } from '../backend.js';

export const RESEARCH_CITATIONS_COMMAND = 'research.citations';

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error';
}

function retryable(code: string): boolean {
  return code === 'rate_limited' || code === 'timeout' || code === 'backend_unavailable';
}

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

interface ResearchCitationsArgs {
  id: string;
  source?: string;
  limit: number;
  cursor?: string;
  requestedAction?: string;
}

function parseArgs(args: Record<string, unknown>): ResearchCitationsArgs {
  const rawId = args.id ?? args.idOrUrl ?? args.query;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) throw invalidInput('id is required');

  let source: string | undefined;
  if (args.source !== undefined) {
    if (typeof args.source !== 'string' || !args.source.trim()) {
      throw invalidInput('source must be a non-empty string');
    }
    source = args.source.trim();
  }

  // Reject-not-clamp: limit must be an integer 1..30
  let limit = 12;
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 30) {
      throw Object.assign(new Error('limit must be an integer 1..30'), { code: 'invalid_request' });
    }
    limit = args.limit;
  }

  let cursor: string | undefined;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length === 0) {
      throw invalidInput('cursor must be a non-empty opaque token');
    }
    if (args.cursor.length > MAX_CURSOR_LENGTH) {
      throw invalidInput(`cursor exceeds maximum length of ${MAX_CURSOR_LENGTH}`);
    }
    cursor = args.cursor;
  }

  const parsed: ResearchCitationsArgs = { id, limit };
  if (source !== undefined) parsed.source = source;
  if (cursor !== undefined) parsed.cursor = cursor;
  if (typeof args.action === 'string') parsed.requestedAction = args.action;
  return parsed;
}

function commandSources(envelope: NorthstarResultV1): NorthstarCommandResultV1['sources'] {
  const names = envelope.sources.map((entry: { source: string }) => entry.source);
  const fallback = typeof envelope.request.source === 'string' ? envelope.request.source : 'research';
  const unique = [...new Set(names.length > 0 ? names : [fallback])];
  return unique.map((name) => ({ kind: 'external' as const, name }));
}

function citationRows(envelope: NorthstarResultV1): NorthstarEntityV1[] {
  return envelope.data.kind === 'entities' ? envelope.data.entities : [];
}

function formatCitationsText(
  envelope: NorthstarResultV1,
  id: string,
  rows: NorthstarEntityV1[],
): string {
  const firstError = envelope.errors[0];
  if (envelope.status === 'error' && firstError) {
    return `Research citations error (${envelope.request.source}): ${firstError.message}`;
  }
  if (rows.length === 0) {
    return `No citations found for: ${id}`;
  }

  const noteTotal = envelope.notes.find((n) => n.startsWith('Total citations:'));
  const header = noteTotal ? `# Citations for ${id} (${noteTotal})` : `# Citations for ${id} (${rows.length} results)`;
  const lines: string[] = [header, ''];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    lines.push(`## ${i + 1}. ${row.title || row.id}`);
    if (row.url) lines.push(row.url);
    const meta: string[] = [];
    if (Array.isArray(row.authors) && row.authors.length > 0) {
      const names = row.authors.map((a: unknown) => {
        if (typeof a === 'object' && a !== null && 'name' in a && typeof (a as { name: unknown }).name === 'string') {
          return (a as { name: string }).name;
        }
        return String(a);
      });
      meta.push(names.slice(0, 3).join(', ') + (names.length > 3 ? ' et al.' : ''));
    }
    if (row.year !== undefined) meta.push(String(row.year));
    const record = row as unknown as Record<string, unknown>;
    const citations = row.metrics?.citations ?? record['citations'];
    if (typeof citations === 'number') meta.push(`Citations: ${citations}`);
    if (meta.length > 0) lines.push(meta.join(' · '));
    if (row.snippet) lines.push(row.snippet);
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function mapResearchCitationsCommandResult(
  envelope: NorthstarResultV1,
  context: CommandContext,
): NorthstarCommandResultV1 {
  const outcome = envelope.status === 'ok' ? 'success'
    : envelope.status === 'empty' ? 'empty'
    : envelope.status === 'partial' ? 'partial'
    : envelope.status === 'degraded' ? 'degraded' : 'failed';
  const firstError = envelope.errors[0];

  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: RESEARCH_CITATIONS_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: commandSources(envelope),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: RESEARCH_CITATIONS_COMMAND,
    attemptedSurfaces: [context.surface, RESEARCH_CITATIONS_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? {
          error: {
            code: firstError.code,
            message: firstError.message,
            retryable: firstError.retryable,
            category: 'research',
          },
        }
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
    commandId: RESEARCH_CITATIONS_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable(code) ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: 'research' }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: RESEARCH_CITATIONS_COMMAND,
    attemptedSurfaces: [context.surface, RESEARCH_CITATIONS_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'Research citations request failed',
      retryable: retryable(code),
      category: code === 'cancelled' ? 'cancelled' : 'research',
    },
  };
  const target = error instanceof Error ? error : new Error('Research citations request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

export async function executeResearchCitations(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  let parsed: ResearchCitationsArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }

  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const envelope = await fetchResearchCitations(
      {
        id: parsed.id,
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
        limit: parsed.limit,
        ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        env: context.env,
        ...(context.lookup !== undefined ? { lookup: context.lookup } : {}),
      },
      {
        tool: 'research',
        channel: 'research',
        action: 'citations',
        ...(parsed.requestedAction !== undefined ? { requestedAction: parsed.requestedAction } : {}),
      },
    );

    const northstarCommand = mapResearchCitationsCommandResult(envelope, context);
    const rows = citationRows(envelope);
    const text = formatCitationsText(envelope, parsed.id, rows);
    const result = northstarTextResult(text, { id: parsed.id, citations: rows }, envelope);
    (result.details as Record<string, unknown>).northstarCommand = northstarCommand;
    return result;
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const researchCitationsHandler = {
  commandId: RESEARCH_CITATIONS_COMMAND,
  execute: executeResearchCitations,
};
