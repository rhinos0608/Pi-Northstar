import { randomUUID } from 'node:crypto';
import type { DnsLookup } from '../network-policy.js';
import type { PageQueryMessages } from '../web/page-query.js';

export interface CommandContext {
  readonly surface: 'cli' | 'pi' | 'skill' | 'workflow' | 'native_tool' | 'internal' | string;
  readonly env: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  /** DNS hook for sandboxed/offline callers; absent means system DNS. */
  readonly lookup?: DnsLookup;
  /** Page text hook for offline/test callers; absent means standard fetch. */
  readonly fetchPageText?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** Current-session model call for fetch answer-mode; absent degrades to evidence-only. */
  readonly probeCall?: (messages: PageQueryMessages) => Promise<string>;
  /** Optional embedding seam for answer-mode coverage. Failure degrades to BM25-only. */
  readonly probeEmbed?: (texts: string[]) => Promise<number[][]>;
  /** Current-session model context window used to budget answer-mode evidence. */
  readonly answerContextTokens?: number;
  readonly invocationId: string;
}

export function createCommandContext(input: Omit<CommandContext, 'invocationId'> & { invocationId?: string }): CommandContext {
  return {
    ...input,
    invocationId: input.invocationId ?? randomUUID(),
  };
}
