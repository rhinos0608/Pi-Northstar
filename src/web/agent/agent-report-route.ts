// Opaque Tavily report leg (Plan C3): wraps the internal Tavily streaming
// report provider. Sync-inside-job by default (S2 pivot: none) — the job runs
// the Tavily stream synchronously inside job execution while poll serves a
// byte-stable snapshot. Provider identity never leaves this module:
// provenance is internal only, never model-visible.

import {
  AGENT_MAX_SOURCES,
  AGENT_REPORT_MAX_BYTES,
  type AgentSourceV1,
} from './agent-contract.js';
import { runAgentReport } from '../web-agent-report.js';

export interface AgentReportInput {
  query: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface AgentReportOutput {
  text: string;
  sources: AgentSourceV1[];
  warnings: string[];
}

/** Truncate UTF-8 text to a byte bound without splitting a code point. */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off over UTF-8 continuation bytes to a character boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export async function runAgentReportRoute(input: AgentReportInput): Promise<AgentReportOutput> {
  const query = input.query.trim();
  if (query === '') throw new Error('agent report requires a non-empty query');
  const result = await runAgentReport(query, input.env, input.signal);
  const warnings: string[] = [];
  let text = result.text;
  if (Buffer.byteLength(text, 'utf8') > AGENT_REPORT_MAX_BYTES) {
    text = truncateUtf8Bytes(text, AGENT_REPORT_MAX_BYTES);
    warnings.push(`report text capped to the ${AGENT_REPORT_MAX_BYTES}-byte evidence budget`);
  }
  const seen = new Set<string>();
  const sources: AgentSourceV1[] = [];
  for (const source of result.sources) {
    if (sources.length >= AGENT_MAX_SOURCES) {
      warnings.push(`sources capped to the ${AGENT_MAX_SOURCES}-source evidence budget`);
      break;
    }
    if (typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) continue;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push({
      id: `r-${sources.length}`,
      url: source.url,
      title: typeof source.title === 'string' && source.title !== '' ? source.title : source.url,
      sourceKind: 'extracted',
    });
  }
  // Provider identity (result.provider) stays internal: never model-visible.
  return { text, sources, warnings };
}
