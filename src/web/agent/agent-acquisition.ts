import { createHash } from 'node:crypto';
import { chunkText } from '../../search/chunker.js';
import { truncateUtf8Bytes } from './agent-report-route.js';
import { createAgentState, type AgentEvidence, type AgentSourceClass } from './agent-state.js';

export interface AgentFetchAcquisition {
  kind: 'fetch'; url: string; canonicalUrl: string; responseId?: string; content: string; title?: string; fetchedAtMs?: number;
}
export interface AgentSearchHitAcquisition { title: string; url: string; snippet?: string; }
export interface AgentSearchAcquisition { kind: 'search'; hits: AgentSearchHitAcquisition[]; }
export type AgentAcquisition = AgentFetchAcquisition | AgentSearchAcquisition;

/** Max fetch content admitted per document (UTF-8 bytes); overlong pages truncate before chunking. */
export const MAX_FETCH_CONTENT_BYTES = 262144;

export interface AgentFetchAdmission { evidence: AgentEvidence[]; truncated: boolean; rejectedCount: number; rejectionReasons: string[]; mergedCount?: number; }

/** Admit fetched chunks only; search hits contain no authoritative document material. */
export function admitFromFetch(state: ReturnType<typeof createAgentState>, fetch: AgentFetchAcquisition, questionIds: string[] = [], round = 0): AgentFetchAdmission {
  let content = fetch.content;
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > MAX_FETCH_CONTENT_BYTES) {
    content = truncateUtf8Bytes(content, MAX_FETCH_CONTENT_BYTES);
    truncated = true;
  }
  // Hoisted: one hash per document, not one per chunk (O(chunks x size) amplifier).
  const documentHash = sha256(content);
  const chunks = chunkText(content);
  const evidence: AgentEvidence[] = [];
  let rejectedCount = 0;
  const reasonSet = new Set<string>();
  let mergedCount = 0;
  for (const chunk of chunks) {
    const result = state.addEvidence({
      sourceRef: { canonicalUrl: fetch.canonicalUrl, ...(fetch.responseId === undefined ? {} : { responseId: fetch.responseId }), sourceClass: sourceClassForUrl(fetch.canonicalUrl), acquisitionRoute: 'fetch' },
      documentHash, locator: { start: chunk.start, end: chunk.end }, excerpt: chunk.text,
      questionIds, round, status: 'admitted', contentLength: content.length,
    });
    if ('rejected' in result) {
      rejectedCount += 1;
      reasonSet.add(result.rejected.reason);
    } else if ('mergedQuestions' in result) {
      // Duplicate-content union: linkage already folded into state; not new
      // evidence, not a rejection — counted separately so fixture metrics hold.
      mergedCount += 1;
    } else {
      evidence.push(result);
    }
  }
  return { evidence, truncated, rejectedCount, rejectionReasons: [...reasonSet].slice(0, 3), mergedCount };
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sourceClassForUrl(url: string): AgentSourceClass {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.gov') || host.endsWith('.edu')) return host.endsWith('.edu') ? 'academic' : 'official';
    if (host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')) return 'repo';
    return 'unknown';
  } catch { return 'unknown'; }
}
