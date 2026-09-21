import { randomUUID } from 'node:crypto';
import type { DnsLookup } from '../network-policy.js';

export interface CommandContext {
  readonly surface: 'cli' | 'pi' | 'skill' | 'workflow' | 'native_tool' | 'internal' | string;
  readonly env: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  /** DNS hook for sandboxed/offline callers; absent means system DNS. */
  readonly lookup?: DnsLookup;
  /** Page text hook for offline/test callers; absent means standard fetch. */
  readonly fetchPageText?: (url: string, signal?: AbortSignal) => Promise<string>;
  readonly invocationId: string;
}

export function createCommandContext(input: Omit<CommandContext, 'invocationId'> & { invocationId?: string }): CommandContext {
  return {
    ...input,
    invocationId: input.invocationId ?? randomUUID(),
  };
}
