// Wave 1 production-boundary adapters (A1/A2/A3, D1/D5).
//
// The native tool seam returns BackendCallResult envelopes whose payloads live
// under `details` (research → details.results, github → details.entities, kg →
// details.knowledge). The gather admission branches only read top-level row
// arrays, so raw envelopes admitted zero rows. These adapters normalize each
// REAL native envelope into a bounded {candidates, evidenceInputs} payload:
//
// - candidates: D6 typed candidates (github-code/github-repo/github-issue/
//   research-source/kg-entity with follow-up-compilable identity, plus generic
//   display-only rows where native rows lack that identity) for the candidate
//   store (discovery only, never evidence).
// - evidenceInputs: rows carrying exactly the keys the admission branches
//   already gate on (research: non-empty `abstract`; github: content/text/body
//   + url). KG search entities are candidate-only per D1 (no KG evidence from
//   search; that arrives with the W3 enhance compiler).
//
// Failure mode is safe: unexpected payloads yield a bounded empty payload +
// warning, never a throw past the executor.

export type { AgentCandidate } from './agent-candidates.js';
import type { AgentCandidate } from './agent-candidates.js';

export interface AdaptedGatherPayload {
  /** Discriminator for the admission branch ('research' | 'github' | 'kg'). */
  source: 'research' | 'github' | 'kg';
  /** D6 typed candidates (follow-up-compilable identity) plus generic
   *  display-only rows for native rows lacking enough identity — never
   *  fabricated into a typed shape. */
  candidates: AgentCandidate[];
  /** Rows shaped for the existing admission gates (see module doc). */
  evidenceInputs: Record<string, unknown>[];
  warnings: string[];
}

/** Row-count bound per adapted payload (native research caps at 30/rows). */
export const MAX_ADAPTED_ROWS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const url = nonEmptyString(value);
  return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined;
}

/** D6 identity derivation: owner/repo from a `full_name` (`owner/repo`) or
 *  repository field. Never fabricated — undefined when the row lacks it. */
function ownerRepoFromFullName(value: unknown): { owner: string; repo: string } | undefined {
  const full = nonEmptyString(value);
  if (full === undefined) return undefined;
  const parts = full.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === undefined || parts[1] === '') return undefined;
  return { owner: parts[0] as string, repo: parts[1] as string };
}

/** D6 identity derivation: owner/repo from a github.com or api.github.com URL. */
function ownerRepoFromGithubUrl(url: string | undefined): { owner: string; repo: string } | undefined {
  if (url === undefined) return undefined;
  const match =
    /^(?:https?:\/\/)(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(url) ??
    /^(?:https?:\/\/)api\.github\.com\/repos\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(url);
  if (match === null) return undefined;
  const owner = match[1] as string;
  const repo = (match[2] as string).replace(/\.git$/, '');
  if (owner === '' || repo === '') return undefined;
  return { owner, repo };
}

/** D6 identity derivation: branch/tag ref from a `/blob/<ref>/` file URL. */
function codeRefFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  return /\/blob\/([^/\s?#]+)\//.exec(url)?.[1];
}

/** D6 identity derivation: owner/repo from a `github:<kind>:owner/repo…` entity id. */
function ownerRepoFromEntityId(id: string | undefined): { owner: string; repo: string } | undefined {
  if (id === undefined) return undefined;
  const match = /^github:[a-z_]+:([^/#@\s]+)\/([^/#@\s]+)/.exec(id);
  if (match === null) return undefined;
  return { owner: match[1] as string, repo: match[2] as string };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Generic display-only fallback: rows lacking follow-up-compilable identity
 *  stay in the bounded listing without a typed shape (never fabricated). */
function genericCandidate(row: Record<string, unknown>, route: AgentCandidate['route'] = 'github'): AgentCandidate {
  return {
    kind: 'generic',
    route,
    ...(nonEmptyString(row['title'] ?? row['path'] ?? row['name']) === undefined
      ? {}
      : { title: (row['title'] ?? row['path'] ?? row['name']) as string }),
    ...(httpUrl(row['canonicalUrl'] ?? row['url']) === undefined
      ? {}
      : { url: httpUrl(row['canonicalUrl'] ?? row['url']) as string }),
    ...(nonEmptyString(row['snippet'] ?? row['description']) === undefined
      ? {}
      : { snippet: (row['snippet'] ?? row['description']) as string }),
  };
}

/** GitHub entity row → D6 typed candidate (github-code / github-repo /
 *  github-issue) or the generic fallback when identity is insufficient. */
function githubCandidate(row: Record<string, unknown>): AgentCandidate {
  const kind = row['kind'];
  const url = httpUrl(row['canonicalUrl'] ?? row['url']);
  if (kind === 'search_result') {
    const identity = ownerRepoFromFullName(row['repository'] ?? row['full_name']) ?? ownerRepoFromGithubUrl(url);
    const path = nonEmptyString(row['path']);
    if (identity !== undefined && path !== undefined && url !== undefined) {
      const ref = codeRefFromUrl(url);
      return {
        kind: 'github-code',
        route: 'github',
        owner: identity.owner,
        repo: identity.repo,
        path,
        ...(ref === undefined ? {} : { ref }),
        url,
        ...(nonEmptyString(row['title'] ?? row['name']) === undefined
          ? {}
          : { title: (row['title'] ?? row['name']) as string }),
        ...(nonEmptyString(row['snippet']) === undefined ? {} : { snippet: row['snippet'] as string }),
      };
    }
    return genericCandidate(row);
  }
  if (kind === 'repo') {
    const identity = ownerRepoFromFullName(row['full_name']) ?? ownerRepoFromGithubUrl(url);
    if (identity !== undefined && url !== undefined) {
      return {
        kind: 'github-repo',
        route: 'github',
        owner: identity.owner,
        repo: identity.repo,
        url,
        ...(nonEmptyString(row['description']) === undefined ? {} : { description: row['description'] as string }),
        ...(nonEmptyString(row['name'] ?? row['title']) === undefined
          ? {}
          : { title: (row['name'] ?? row['title']) as string }),
        ...(nonEmptyString(row['snippet'] ?? row['description']) === undefined
          ? {}
          : { snippet: (row['snippet'] ?? row['description']) as string }),
      };
    }
    return genericCandidate(row);
  }
  if (kind === 'issue') {
    const number = positiveInt(row['number']);
    const title = nonEmptyString(row['title']);
    const identity =
      ownerRepoFromEntityId(nonEmptyString(row['id'])) ?? ownerRepoFromGithubUrl(url);
    if (number !== undefined && title !== undefined && url !== undefined && identity !== undefined) {
      return {
        kind: 'github-issue',
        route: 'github',
        owner: identity.owner,
        repo: identity.repo,
        number,
        url,
        title,
        ...(nonEmptyString(row['snippet'] ?? row['body']) === undefined
          ? {}
          : { snippet: (row['snippet'] ?? row['body']) as string }),
      };
    }
    return genericCandidate(row);
  }
  return genericCandidate(row);
}

function detailsOf(payload: unknown): Record<string, unknown> | undefined {
  return isRecord(payload) ? (isRecord(payload['details']) ? (payload['details'] as Record<string, unknown>) : undefined) : undefined;
}

/** Canonical envelope entities (details.northstar.data.entities) as fallback rows. */
function northstarEntities(details: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const northstar = details !== undefined ? details['northstar'] : undefined;
  const data = isRecord(northstar) ? northstar['data'] : undefined;
  const entities = isRecord(data) ? data['entities'] : undefined;
  if (!Array.isArray(entities)) return [];
  return entities.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

/** First array found under alias keys (mirrors the admission pickArray). */
function pickRows(record: Record<string, unknown> | undefined, keys: string[]): Array<Record<string, unknown>> {
  if (record === undefined) return [];
  for (const key of keys) {
    const pool = record[key];
    if (Array.isArray(pool)) {
      return pool.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    }
  }
  return [];
}

function emptyPayload(source: AdaptedGatherPayload['source'], warnings: string[]): AdaptedGatherPayload {
  return { source, candidates: [], evidenceInputs: [], warnings };
}

function boundWarning(source: string, trimmed: number): string | undefined {
  return trimmed > 0 ? `${source} adapter: truncated ${trimmed} row(s) past the ${MAX_ADAPTED_ROWS}-row bound` : undefined;
}

function takeBound<T>(rows: T[]): { kept: T[]; trimmed: number } {
  return rows.length > MAX_ADAPTED_ROWS
    ? { kept: rows.slice(0, MAX_ADAPTED_ROWS), trimmed: rows.length - MAX_ADAPTED_ROWS }
    : { kept: rows, trimmed: 0 };
}

export function isAdaptedGatherPayload(value: unknown): value is AdaptedGatherPayload {
  if (!isRecord(value)) return false;
  if (value['source'] !== 'research' && value['source'] !== 'github' && value['source'] !== 'kg') return false;
  return Array.isArray(value['candidates']) && Array.isArray(value['evidenceInputs']);
}

/**
 * Adapt a REAL native research BackendCallResult (details.results rows shaped
 * by native-tools.ts:154-159: {title, url, snippet, source, abstract?}).
 * Evidence inputs keep only rows with a genuine non-empty `abstract` (D5:
 * never backfilled from snippet); abstract-less sources stay candidate-only.
 */
export function adaptResearchResult(payload: unknown): AdaptedGatherPayload {
  const source = 'research' as const;
  try {
    const details = detailsOf(payload);
    let rows = pickRows(details, ['results', 'abstracts', 'items', 'entries']);
    if (rows.length === 0) {
      // Canonical-envelope fallback: map northstar entities to detail rows.
      rows = northstarEntities(details).map((entity) => ({
        ...entity,
        ...(nonEmptyString(entity['snippet']) === undefined ? {} : { snippet: entity['snippet'] as string }),
      }));
    }
    if (rows.length === 0) {
      // A present-but-empty list is a legitimate zero-result search (the
      // native research surface sets details.results, [] when no rows match)
      // — NOT an unexpected shape. Only a missing list is out of contract.
      // Either way the payload stays bounded-empty.
      const zeroResult =
        details !== undefined &&
        ['results', 'abstracts', 'items', 'entries'].some((key) => Array.isArray(details[key]));
      return emptyPayload(source, [
        zeroResult
          ? 'research adapter: zero results returned; returning empty'
          : 'research adapter: unexpected native payload (missing details.results); returning empty',
      ]);
    }
    const { kept, trimmed } = takeBound(rows);
    const warnings: string[] = [];
    const truncated = boundWarning('research', trimmed);
    if (truncated !== undefined) warnings.push(truncated);
    // D6: rows carrying source+title+url compile to research-source follow-up
    // fetch intents; rows lacking that identity stay generic (display-only).
    const candidates: AgentCandidate[] = kept.map((row) => {
      const source = nonEmptyString(row['source']);
      const title = nonEmptyString(row['title']);
      const url = httpUrl(row['canonicalUrl'] ?? row['url']);
      if (source !== undefined && title !== undefined && url !== undefined) {
        return {
          kind: 'research-source',
          route: 'research',
          source,
          title,
          url,
          ...(nonEmptyString(row['snippet'] ?? row['abstract']) === undefined
            ? {}
            : { snippet: (row['snippet'] ?? row['abstract']) as string }),
        } as AgentCandidate;
      }
      return genericCandidate(row, 'research');
    });
    // D5: evidence ONLY when the upstream row genuinely carried an abstract.
    const evidenceInputs = kept.filter((row) => nonEmptyString(row['abstract']) !== undefined);
    return { source, candidates, evidenceInputs, warnings };
  } catch {
    return emptyPayload(source, ['research adapter: unexpected native payload; returning empty']);
  }
}

/**
 * Adapt a REAL native github BackendCallResult (details.entities rows shaped
 * by GithubEntityV1: file rows carry content+url, issue/pull/release rows
 * carry body+url, repo/search_result rows carry description/snippet only).
 * Evidence inputs keep only content/text/body + url rows (B3: repo/code
 * snippets stay candidate-only).
 */
export function adaptGithubResult(payload: unknown): AdaptedGatherPayload {
  const source = 'github' as const;
  try {
    const details = detailsOf(payload);
    let rows = pickRows(details, ['entities', 'contents', 'results', 'items', 'files']);
    if (rows.length === 0) {
      // Canonical-envelope fallback (mirrors the research adapter): some
      // native envelopes carry entities only under details.northstar.
      rows = northstarEntities(details);
    }
    if (rows.length === 0) {
      // A present-but-empty list is a legitimate zero-result search
      // (github-domain.ts always sets legacyDetails.entities, [] when no
      // rows match) — NOT an unexpected shape. Only a missing list is out
      // of contract. Either way the payload stays bounded-empty.
      const zeroResult =
        details !== undefined &&
        ['entities', 'contents', 'results', 'items', 'files'].some((key) => Array.isArray(details[key]));
      return emptyPayload(source, [
        zeroResult
          ? 'github adapter: zero entities returned; returning empty'
          : 'github adapter: unexpected native payload (missing details.entities); returning empty',
      ]);
    }
    const { kept, trimmed } = takeBound(rows);
    const warnings: string[] = [];
    const truncated = boundWarning('github', trimmed);
    if (truncated !== undefined) warnings.push(truncated);
    const candidates: AgentCandidate[] = kept.map((row) => githubCandidate(row));
    // B3: only retrieved content (file content, issue/pr/release body) + url
    // rows admit; repo metadata and code-search snippets stay candidates.
    const evidenceInputs = kept.filter(
      (row) =>
        nonEmptyString(row['content'] ?? row['text'] ?? row['body']) !== undefined &&
        httpUrl(row['canonicalUrl'] ?? row['url']) !== undefined,
    );
    return { source, candidates, evidenceInputs, warnings };
  } catch {
    return emptyPayload(source, ['github adapter: unexpected native payload; returning empty']);
  }
}

/**
 * Adapt a REAL native kg BackendCallResult (details.knowledge KgResult
 * envelope; KgEntity {entityVersion, id, type, name?, url?, confidence?}).
 * D1: bare search entities are candidate-only — evidenceInputs is empty for
 * data.kind 'search' (claim/field evidence arrives only with the W3 enhance
 * compiler). For data.kind 'enhance' (native-tools.ts:498-501: {entities,
 * claims, conflicts, partitions, groups, evidence}): primary evidence rows
 * from claims → {nodeId: claim.subjectId (post-alignment public group id),
 * field: claim predicate, value: claim value}; secondary rows from entity
 * identity fields only (name/url/description) where populated. Fields are
 * NEVER fabricated from bare search entities.
 */
export function adaptKgResult(payload: unknown): AdaptedGatherPayload {
  const source = 'kg' as const;
  try {
    const details = detailsOf(payload);
    const knowledge = details !== undefined ? details['knowledge'] : undefined;
    const data = isRecord(knowledge) ? knowledge['data'] : undefined;
    const enhance = isRecord(data) && data['kind'] === 'enhance';
    const entities = isRecord(data) && Array.isArray(data['entities'])
      ? (data['entities'] as unknown[]).filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const claims = enhance && isRecord(data) && Array.isArray(data['claims'])
      ? (data['claims'] as unknown[]).filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    let rows = entities;
    if (rows.length === 0) {
      rows = pickRows(details, ['entities', 'fields', 'results', 'items']);
    }
    if (rows.length === 0 && claims.length === 0) {
      // A present-but-empty list is a legitimate zero-result search (the
      // native kg surface sets data.entities, [] when no rows match) — NOT
      // an unexpected shape. Only a missing envelope is out of contract.
      // Either way the payload stays bounded-empty.
      const dataEntities = isRecord(data) && Array.isArray(data['entities']);
      const zeroResult =
        dataEntities ||
        (details !== undefined && ['entities', 'fields', 'results', 'items'].some((key) => Array.isArray(details[key])));
      return emptyPayload(source, [
        zeroResult
          ? 'kg adapter: zero entities returned; returning empty'
          : 'kg adapter: unexpected native payload (missing details.knowledge); returning empty',
      ]);
    }
    const { kept, trimmed } = takeBound(rows);
    const warnings: string[] = [];
    const truncated = boundWarning('kg', trimmed);
    if (truncated !== undefined) warnings.push(truncated);
    // D1/D6: search entities with a compilable Person|Organization selector
    // become kg-entity follow-up lookups; anything else stays generic.
    const candidates: AgentCandidate[] = kept.map((row) => {
      const id = nonEmptyString(row['id']);
      const entityType = row['type'];
      if (
        id !== undefined &&
        (entityType === 'Person' || entityType === 'Organization')
      ) {
        const url = httpUrl(row['canonicalUrl'] ?? row['url']);
        return {
          kind: 'kg-entity',
          route: 'kg',
          entityType,
          id,
          ...(nonEmptyString(row['title'] ?? row['name']) === undefined
            ? {}
            : { title: (row['title'] ?? row['name']) as string }),
          ...(nonEmptyString(row['name']) === undefined ? {} : { name: row['name'] as string }),
          ...(url === undefined ? {} : { url }),
          ...(nonEmptyString(row['snippet'] ?? row['value'] ?? row['text']) === undefined
            ? {}
            : { snippet: (row['snippet'] ?? row['value'] ?? row['text']) as string }),
        } as AgentCandidate;
      }
      return genericCandidate(row, 'kg');
    });
    // D1: bare search entities stay candidate-only. Enhance claims + entity
    // identity fields become admission-shaped {nodeId, field, value} rows.
    if (!enhance) {
      return { source, candidates, evidenceInputs: [], warnings };
    }
    const evidenceInputs: Record<string, unknown>[] = [];
    for (const claim of claims) {
      const nodeId = nonEmptyString(claim['subjectId']);
      const field = nonEmptyString(claim['predicate']);
      const value = nonEmptyString(claim['object']);
      if (nodeId === undefined || field === undefined || value === undefined) continue;
      evidenceInputs.push({ nodeId, field, value });
    }
    for (const entity of entities) {
      const nodeId = nonEmptyString(entity['id']);
      if (nodeId === undefined) continue;
      for (const field of ['name', 'url', 'description'] as const) {
        const value = nonEmptyString(entity[field]);
        if (value === undefined) continue;
        if (field === 'url' && httpUrl(value) === undefined) continue;
        evidenceInputs.push({ nodeId, field, value });
      }
    }
    const bounded = takeBound(evidenceInputs);
    const evidenceTruncated = boundWarning('kg', bounded.trimmed);
    if (evidenceTruncated !== undefined) warnings.push(evidenceTruncated);
    return { source, candidates, evidenceInputs: bounded.kept, warnings };
  } catch {
    return emptyPayload(source, ['kg adapter: unexpected native payload; returning empty']);
  }
}
