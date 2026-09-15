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
/** Claim text ceiling: UTF-8 bytes, not chars (same convention as reportText). */
export const AGENT_CLAIM_MAX_BYTES = 5_000;
/** Warning string ceiling: UTF-8 bytes, not chars (same convention as reportText). */
export const AGENT_WARNING_MAX_BYTES = 2_000;
/** Default execution lifetime: drive rejects past this (drive deadline). */
export const AGENT_RUN_DEADLINE_MS = 1_800_000;
/** Execution-lifetime cap: configured deadlines above this reject, never clamp. */
export const AGENT_RUN_DEADLINE_MAX_MS = 7_200_000;
/** Terminal-result pollability after settle (ready/failed stay readable). */
export const AGENT_RESULT_RETENTION_TTL_MS = 86_400_000;
/** In-flight snapshot freshness without change: staleness only, never expiry. */
export const AGENT_POLL_VISIBILITY_TTL_MS = 300_000;
/** Job lifetime: derived single source — max of the lifecycle split (run deadline, result retention, poll visibility). */
export const AGENT_JOB_TTL_MS = Math.max(AGENT_RUN_DEADLINE_MS, AGENT_RESULT_RETENTION_TTL_MS, AGENT_POLL_VISIBILITY_TTL_MS);

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
  /** Required on derived sources; optional on extracted sources. */
  warnings?: string[];
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

/** Source entry fields the validator recognizes; anything else rejects (never silently passed). */
const ALLOWED_SOURCE_FIELDS = new Set(['id', 'url', 'title', 'sourceKind', 'locator', 'warnings']);

/** Locator fields the validator recognizes; anything else rejects. */
const ALLOWED_LOCATOR_FIELDS = new Set(['page', 'timestamp', 'location']);

/** Derived locator check: non-empty object, known fields only, bounded values. */
function checkAgentLocator(locator: unknown, index: number): string[] {
  const prefix = `sources[${index}].locator`;
  if (typeof locator !== 'object' || locator === null || Array.isArray(locator)) {
    return [`${prefix} is required for derived sources`];
  }
  const record = locator as Record<string, unknown>;
  const out: string[] = [];
  for (const key of Object.keys(record)) {
    if (!ALLOWED_LOCATOR_FIELDS.has(key)) out.push(`${prefix} has unknown field "${key}"`);
  }
  const present = [...ALLOWED_LOCATOR_FIELDS].filter((key) => record[key] !== undefined);
  if (present.length === 0) {
    out.push(`${prefix} must carry at least one of page, timestamp, location`);
    return out;
  }
  const page = record['page'];
  if (page !== undefined && (typeof page !== 'number' || !Number.isInteger(page) || page < 0)) {
    out.push(`${prefix}.page must be a non-negative integer`);
  }
  for (const field of ['timestamp', 'location'] as const) {
    const entry = record[field];
    if (entry !== undefined && (typeof entry !== 'string' || entry.trim() === '')) {
      out.push(`${prefix}.${field} must be a non-empty string`);
    }
  }
  return out;
}

/** Warnings check: non-empty array, non-empty strings within the byte budget. */
function checkAgentWarnings(warnings: unknown, index: number, scope: string): string[] {
  const prefix = `sources[${index}].warnings`;
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return [`${prefix} must be an array of strings for ${scope} (non-empty)`];
  }
  const out: string[] = [];
  for (const [position, warning] of warnings.entries()) {
    if (typeof warning !== 'string' || warning.trim() === '') {
      out.push(`${prefix}[${position}] must be a non-empty string`);
    } else if (Buffer.byteLength(warning, 'utf8') > AGENT_WARNING_MAX_BYTES) {
      out.push(`${prefix}[${position}] exceeds maximum of ${AGENT_WARNING_MAX_BYTES} bytes (UTF-8)`);
    }
  }
  return out;
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
      else if (ids.has(entry['id'] as string)) issues.push(`sources[${index}].id is a duplicate`);
      else ids.add(entry['id'] as string);
      if (typeof entry['url'] !== 'string' || !/^https?:\/\//i.test(entry['url'] as string)) {
        issues.push(`sources[${index}].url must be an http(s) URL`);
      }
      if (typeof entry['title'] !== 'string') issues.push(`sources[${index}].title must be a string`);
      if (entry['sourceKind'] !== 'extracted' && entry['sourceKind'] !== 'derived') {
        issues.push(`sources[${index}].sourceKind must be extracted or derived`);
      } else if (entry['sourceKind'] === 'derived') {
        issues.push(...checkAgentLocator(entry['locator'], index));
        issues.push(...checkAgentWarnings(entry['warnings'], index, 'derived sources'));
      } else {
        // Extracted sources keep locator/warnings optional, but present values
        // validate under the same rules instead of passing silently.
        if (entry['locator'] !== undefined) issues.push(...checkAgentLocator(entry['locator'], index));
        if (entry['warnings'] !== undefined) issues.push(...checkAgentWarnings(entry['warnings'], index, 'extracted sources'));
      }
      for (const key of Object.keys(entry)) {
        if (!ALLOWED_SOURCE_FIELDS.has(key)) issues.push(`sources[${index}] has unknown field "${key}"`);
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
        } else if (Buffer.byteLength(entry['text'] as string, 'utf8') > AGENT_CLAIM_MAX_BYTES) {
          issues.push(`claims[${index}].text exceeds maximum of ${AGENT_CLAIM_MAX_BYTES} bytes (UTF-8)`);
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
  } else {
    for (const [position, warning] of (result['warnings'] as string[]).entries()) {
      if (Buffer.byteLength(warning, 'utf8') > AGENT_WARNING_MAX_BYTES) {
        issues.push(`warnings[${position}] exceeds maximum of ${AGENT_WARNING_MAX_BYTES} bytes (UTF-8)`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}
