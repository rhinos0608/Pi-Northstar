// Agent contract (Plan C1): result/job shapes, evidence budgets, citation,
// document, and lexical contracts, plus the byte-stable serialization rule.
// Budget numbers are approved defaults — tests read them
// from here so renames/renumbers touch this file only.

/** Report text ceiling: UTF-8 bytes, not chars. */
export const AGENT_REPORT_MAX_BYTES = 50_000;
/** Max cited sources on a finished result. */
export const AGENT_MAX_SOURCES = 20;
/** Max sources admitted from the local search leg. */
export const AGENT_LOCAL_MAX_SOURCES = 30;
/** Max fetch rounds on the local leg. */
export const AGENT_MAX_FETCH_ROUNDS = 8;
/** Job lifetime: mirrors the web-access store TTL (1h). */
export const AGENT_JOB_TTL_MS = 3_600_000;

export interface AgentClaimV1 {
  /** Claim text (model-visible, untrusted evidence). */
  text: string;
  /** Every claim cites >=1 source id from sources. */
  sourceIds: string[];
}

export interface AgentSourceV1 {
  id: string;
  url: string;
  title: string;
  /** Document contract: derived docs carry sourceKind + locator + warnings. */
  sourceKind: 'extracted' | 'derived';
  locator?: { page?: number; timestamp?: string; location?: string };
}

export interface AgentResultV1 {
  version: 1;
  query: string;
  reportText: string;
  claims: AgentClaimV1[];
  sources: AgentSourceV1[];
  warnings: string[];
}

export type AgentJobStatus = 'running' | 'ready' | 'failed';

export interface AgentJobV1 {
  jobId: string;
  query: string;
  status: AgentJobStatus;
  createdAt: number;
  updatedAt: number;
  /** Per-entry owner binding (Plan B1 pivot): job id owns job-derived store
   *  entries; this field gates poll access. Absent = unowned. */
  owner?: string;
  result?: AgentResultV1;
  error?: string;
  rpc: import('./agent-rpc.js').AgentRpcRecord;
}

/**
 * Byte-stable serialization: canonical JSON with recursively sorted object
 * keys. Identical job state always yields identical bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Citation + document + budget contract check. Fail-closed: issues listed. */
export function validateAgentResult(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['result is not an object'] };
  }
  const result = value as Record<string, unknown>;
  if (result['version'] !== 1) issues.push('version must be 1');
  if (typeof result['query'] !== 'string' || (result['query'] as string).trim() === '') issues.push('query is required');
  if (typeof result['reportText'] !== 'string') {
    issues.push('reportText must be a string');
  } else if (Buffer.byteLength(result['reportText'] as string, 'utf8') > AGENT_REPORT_MAX_BYTES) {
    issues.push(`reportText exceeds maximum of ${AGENT_REPORT_MAX_BYTES} bytes (UTF-8)`);
  }
  const sources = result['sources'];
  if (!Array.isArray(sources)) {
    issues.push('sources must be an array');
  } else {
    if (sources.length > AGENT_MAX_SOURCES) issues.push(`sources exceed maximum of ${AGENT_MAX_SOURCES}`);
    const ids = new Set<string>();
    for (const [index, source] of sources.entries()) {
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        issues.push(`sources[${index}] is not an object`);
        continue;
      }
      const entry = source as Record<string, unknown>;
      if (typeof entry['id'] !== 'string' || (entry['id'] as string) === '') issues.push(`sources[${index}].id is required`);
      else ids.add(entry['id'] as string);
      if (typeof entry['url'] !== 'string' || !/^https?:\/\//i.test(entry['url'] as string)) {
        issues.push(`sources[${index}].url must be an http(s) URL`);
      }
      if (typeof entry['title'] !== 'string') issues.push(`sources[${index}].title must be a string`);
      if (entry['sourceKind'] !== 'extracted' && entry['sourceKind'] !== 'derived') {
        issues.push(`sources[${index}].sourceKind must be extracted or derived`);
      }
    }
    const claims = result['claims'];
    if (!Array.isArray(claims)) {
      issues.push('claims must be an array');
    } else {
      for (const [index, claim] of claims.entries()) {
        if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) {
          issues.push(`claims[${index}] is not an object`);
          continue;
        }
        const entry = claim as Record<string, unknown>;
        if (typeof entry['text'] !== 'string' || (entry['text'] as string).trim() === '') {
          issues.push(`claims[${index}].text is required`);
        }
        if (!Array.isArray(entry['sourceIds']) || (entry['sourceIds'] as unknown[]).length === 0) {
          issues.push(`claims[${index}] must cite at least one sourceId`);
        } else {
          for (const id of entry['sourceIds'] as unknown[]) {
            if (typeof id !== 'string' || !ids.has(id)) issues.push(`claims[${index}] cites unknown sourceId`);
          }
        }
      }
    }
  }
  if (!Array.isArray(result['warnings']) || (result['warnings'] as unknown[]).some((w) => typeof w !== 'string')) {
    issues.push('warnings must be an array of strings');
  }
  return { ok: issues.length === 0, issues };
}
