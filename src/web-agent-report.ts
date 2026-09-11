// Provider-neutral agent-report registry for web_search mode:"agent".
// First provider is Tavily Research (POST /research streaming SSE).
// Future report-capable providers append to REPORT_PROVIDERS; web.ts never
// sees provider specifics. Terminal provider failure throws immediately with
// a neutral provider-attributed message (no secrets, payloads, or progress).

import { providerSignal } from './web-provider-policy.js';
import { runTavilyResearch } from './web-tavily.js';
import { isTerminalReportError } from './web-search-types.js';
import type { WebReportProviderId, WebReportResult } from './web-search-types.js';

export const DEFAULT_WEB_AGENT_TIMEOUT_MS = 300_000;

export interface WebReportProviderInput {
  query: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface WebReportProvider {
  readonly id: WebReportProviderId;
  configured(env: Record<string, string | undefined>): boolean;
  generate(input: WebReportProviderInput): Promise<WebReportResult>;
}

export const tavilyReportProvider: WebReportProvider = {
  id: 'tavily',
  configured(env): boolean {
    return (env.TAVILY_API_KEY?.trim().length ?? 0) > 0;
  },
  async generate(input): Promise<WebReportResult> {
    return runTavilyResearch(input.query, input.env, input.signal);
  },
};

/** Report-capable providers in preference order. Tavily first. */
export const REPORT_PROVIDERS: readonly WebReportProvider[] = [tavilyReportProvider];

export function resolveReportProvider(env: Record<string, string | undefined>): WebReportProvider {
  for (const provider of REPORT_PROVIDERS) {
    if (provider.configured(env)) return provider;
  }
  throw new Error('No report-capable web search providers configured');
}

/**
 * Operator deadline for agent reports. Clamped to DEFAULT_WEB_AGENT_TIMEOUT_MS
 * so the deadline never outruns the 300s CLI-backend route timeout.
 */
export function resolveAgentTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.PI_SEARCH_WEB_AGENT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WEB_AGENT_TIMEOUT_MS;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PI_SEARCH_WEB_AGENT_TIMEOUT_MS: expected positive integer, got "${raw}"`);
  }
  return Math.min(parsed, DEFAULT_WEB_AGENT_TIMEOUT_MS);
}

/** Run one streaming report generation under the operator deadline signal. */
export async function runAgentReport(
  query: string,
  env: Record<string, string | undefined>,
  callerSignal?: AbortSignal,
): Promise<WebReportResult> {
  const provider = resolveReportProvider(env);
  const timeoutMs = resolveAgentTimeoutMs(env);
  callerSignal?.throwIfAborted();
  // One composed caller+deadline signal across the entire POST + stream.
  // The timer is unref'd and self-clears on abort; nothing to release after.
  const signal = providerSignal(callerSignal, timeoutMs);
  try {
    return await provider.generate({ query, env, signal });
  } catch (error) {
    if ((error as { name?: unknown })?.name === 'AbortError' || callerSignal?.aborted) throw error;
    if (isTerminalReportError(error)) {
      throw new Error(`Web report provider "${provider.id}" terminally failed`, { cause: error });
    }
    throw error;
  }
}
