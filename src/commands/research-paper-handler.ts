import { northstarTextResult } from '../core/tool-output.js';
import { fetchResearchPaper } from '../research/research-sources.js';
import type { NorthstarEntityV1, NorthstarResultV1 } from '../result-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import type { BackendCallResult } from '../backend.js';

export const RESEARCH_PAPER_COMMAND = 'research.paper';

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

interface ResearchPaperArgs {
  idOrUrl: string;
  source?: string;
  requestedAction?: string;
}

function parseArgs(args: Record<string, unknown>): ResearchPaperArgs {
  const rawId = args.idOrUrl ?? args.id ?? args.url;
  const idOrUrl = typeof rawId === 'string' ? rawId.trim() : '';
  if (!idOrUrl) throw invalidInput('ID or URL is required');

  let source: string | undefined;
  if (args.source !== undefined) {
    if (typeof args.source !== 'string' || !args.source.trim()) {
      throw invalidInput('source must be a non-empty string');
    }
    source = args.source.trim();
  }

  const parsed: ResearchPaperArgs = { idOrUrl };
  if (source !== undefined) parsed.source = source;
  if (typeof args.action === 'string') parsed.requestedAction = args.action;
  return parsed;
}

function commandSources(envelope: NorthstarResultV1): NorthstarCommandResultV1['sources'] {
  const names = envelope.sources.map((entry: { source: string }) => entry.source);
  const fallback = typeof envelope.request.source === 'string' ? envelope.request.source : 'research';
  const unique = [...new Set(names.length > 0 ? names : [fallback])];
  return unique.map((name) => ({ kind: 'external' as const, name }));
}

function paperEntity(envelope: NorthstarResultV1): NorthstarEntityV1 | undefined {
  return envelope.data.kind === 'entities' && envelope.data.entities[0]
    ? envelope.data.entities[0]
    : undefined;
}

function formatPaperText(
  paper: NorthstarEntityV1 | undefined,
  idOrUrl: string,
  envelope: NorthstarResultV1,
): string {
  const firstError = envelope.errors[0];
  if (envelope.status === 'error' && firstError) {
    return `Research paper error (${envelope.request.source}): ${firstError.message}`;
  }
  if (!paper) {
    return `No paper metadata found for: ${idOrUrl}`;
  }

  const record = paper as unknown as Record<string, unknown>;
  const lines: string[] = [`# ${paper.title || paper.id}`];
  if (paper.url) lines.push(paper.url);

  const meta: string[] = [];
  if (Array.isArray(paper.authors) && paper.authors.length > 0) {
    const names = paper.authors.map((a: unknown) => {
      if (typeof a === 'object' && a !== null && 'name' in a && typeof (a as { name: unknown }).name === 'string') {
        return (a as { name: string }).name;
      }
      return String(a);
    });
    meta.push(`Authors: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' et al.' : ''}`);
  }
  if (paper.year !== undefined) meta.push(`Year: ${paper.year}`);
  if (paper.venue) meta.push(`Venue: ${paper.venue}`);
  if (paper.doi) meta.push(`DOI: ${paper.doi}`);
  const citations = paper.metrics?.citations ?? record['citations'];
  if (typeof citations === 'number') meta.push(`Citations: ${citations}`);
  if (meta.length > 0) lines.push(meta.join('\n'));

  const abstract = typeof record['abstract'] === 'string' ? record['abstract'] : undefined;
  if (abstract) {
    lines.push(`\n## Abstract\n${abstract}`);
  } else if (paper.snippet) {
    lines.push(`\n## Summary\n${paper.snippet}`);
  }

  return lines.join('\n\n');
}

export function mapResearchPaperCommandResult(
  envelope: NorthstarResultV1,
  context: CommandContext,
): NorthstarCommandResultV1 {
  const outcome = envelope.status === 'ok' ? 'success'
    : envelope.status === 'empty' ? 'empty'
    : envelope.status === 'partial' ? 'partial'
    : envelope.status === 'degraded' ? 'degraded' : 'failed';
  const firstError = envelope.errors[0];
  const mappedCode = firstError?.message?.includes('not found') ? 'not_found' : firstError?.code;

  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: RESEARCH_PAPER_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: commandSources(envelope),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: RESEARCH_PAPER_COMMAND,
    attemptedSurfaces: [context.surface, RESEARCH_PAPER_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? {
          error: {
            code: mappedCode ?? firstError.code,
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
    commandId: RESEARCH_PAPER_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable(code) ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: 'research' }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: RESEARCH_PAPER_COMMAND,
    attemptedSurfaces: [context.surface, RESEARCH_PAPER_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'Research paper request failed',
      retryable: retryable(code),
      category: code === 'cancelled' ? 'cancelled' : 'research',
    },
  };
  const target = error instanceof Error ? error : new Error('Research paper request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

export async function executeResearchPaper(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  let parsed: ResearchPaperArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }

  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const envelope = await fetchResearchPaper(
      {
        idOrUrl: parsed.idOrUrl,
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        env: context.env,
        ...(context.lookup !== undefined ? { lookup: context.lookup } : {}),
      },
      {
        tool: 'research',
        channel: 'research',
        action: 'paper',
        ...(parsed.requestedAction !== undefined ? { requestedAction: parsed.requestedAction } : {}),
      },
    );

    const northstarCommand = mapResearchPaperCommandResult(envelope, context);
    const paper = paperEntity(envelope);
    const text = formatPaperText(paper, parsed.idOrUrl, envelope);
    const result = northstarTextResult(text, { idOrUrl: parsed.idOrUrl, paper }, envelope);
    (result.details as Record<string, unknown>).northstarCommand = northstarCommand;
    return result;
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const researchPaperHandler = {
  commandId: RESEARCH_PAPER_COMMAND,
  execute: executeResearchPaper,
};
