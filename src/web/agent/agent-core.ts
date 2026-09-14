// Agent core (Plan C2): deterministic shell over existing search + fetch +
// fusion ranking, with a BM25 lexical pass over src/search/bm25.ts.
// Provider/model opacity: provenance fields on dependency outputs are
// stripped before composition and never appear model-visible.

import { BM25Index } from '../../search/bm25.js';
import { rrfMerge } from '../../search/fusion.js';
import {
  AGENT_CLAIM_MAX_BYTES,
  AGENT_LOCAL_MAX_SOURCES,
  AGENT_MAX_FETCH_ROUNDS,
  AGENT_MAX_SOURCES,
  type AgentClaimV1,
  type AgentResultV1,
  type AgentSourceV1,
} from './agent-contract.js';
import { truncateUtf8Bytes } from './agent-report-route.js';

export interface AgentSearchHit {
  title: string;
  url: string;
  snippet?: string;
  /** Provenance remnant keys are stripped, never composed into output. */
  [key: string]: unknown;
}

export interface AgentCoreDeps {
  search(query: string): Promise<AgentSearchHit[]>;
  fetchText(url: string): Promise<string>;
  report(query: string): Promise<{
    text: string;
    sources: Array<{ url: string; title: string }>;
    warnings?: string[];
    /** Optional structured claims carrying their own source associations.
     *  sourceIds must reference composed source ids; unverifiable entries drop. */
    claims?: Array<{ text: string; sourceIds: string[] }>;
  }>;
}

/** Strip provider/model/secret provenance before composition. Substring stems
 *  catch key variants (providers, modelName, providerId, authToken, apiKeys,
 *  backendName, tokens, x-provider, passwd, password, credential, bearer,
 *  private_key); exact author/authors survive the auth stem; composed keys
 *  (title/url/text/query/sources/claims) carry none of these stems and survive. */
export function redactProvenance<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactProvenance) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^authors?$/i.test(key)) {
        out[key] = redactProvenance(entry);
        continue;
      }
      if (/(provider|model|token|secret|api[_-]?key|auth|backend|passwd|password|credential|bearer|private[_-]?key)/i.test(key)) continue;
      out[key] = redactProvenance(entry);
    }
    return out as T;
  }
  return value;
}

function splitClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export async function runAgentCore(query: string, deps: AgentCoreDeps): Promise<AgentResultV1> {
  const trimmed = query.trim();
  if (trimmed === '') throw new Error('agent core requires a non-empty query');
  const warnings: string[] = [];

  // Local leg: bounded search, then bounded fetch rounds over the top hits.
  const rawHits = redactProvenance(await deps.search(trimmed));
  const hits = rawHits
    .filter((hit) => typeof hit.url === 'string' && /^https?:\/\//i.test(hit.url))
    .slice(0, AGENT_LOCAL_MAX_SOURCES);
  const fetchRounds = Math.min(hits.length, AGENT_MAX_FETCH_ROUNDS);
  const passages: Array<{ id: string; url: string; title: string; text: string }> = [];
  for (let index = 0; index < fetchRounds; index += 1) {
    const hit = hits[index]!;
    try {
      const body = await deps.fetchText(hit.url);
      if (body.trim() !== '') {
        passages.push({ id: `s-${index}`, url: hit.url, title: hit.title || hit.url, text: body });
      }
    } catch {
      warnings.push(`fetch round ${index} failed; passage skipped`);
    }
  }

  // Lexical contract: BM25 pass over the fetched passages.
  const bm25 = new BM25Index();
  for (const passage of passages) bm25.add(passage.id, `${passage.title}\n${passage.text}`);
  const ranked = bm25.search(trimmed, AGENT_MAX_SOURCES);
  const rankIndex = new Map(ranked.map((entry, order) => [entry.id, order]));
  // One RRF pass fusing fetch order with the BM25 lexical ranking.
  const fused = rrfMerge([passages.map((p) => p.id), ranked.map((r) => r.id)], { keyFn: (id: string) => id });
  const fusedOrder = new Map(fused.map((entry, order) => [entry.item, order]));
  const ordered = [...passages].sort((a, b) => {
    const fa = fusedOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const fb = fusedOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    return (rankIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rankIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });

  // Opaque Tavily leg runs synchronously inside the job; failure degrades to
  // local-only evidence with a warning (never a throw that kills the job).
  let reportText = '';
  const reportSources: Array<{ url: string; title: string }> = [];
  let structuredClaims: Array<{ text: string; sourceIds: string[] }> = [];
  try {
    const report = redactProvenance(await deps.report(trimmed));
    reportText = report.text;
    for (const source of report.sources) reportSources.push(source);
    for (const warning of report.warnings ?? []) warnings.push(warning);
    structuredClaims = report.claims ?? [];
  } catch {
    warnings.push('opaque report leg unavailable; local evidence only');
  }

  // Compose sources: report sources first (extracted), then lexical top-ups.
  const seen = new Set<string>();
  const sources: AgentSourceV1[] = [];
  const pushSource = (url: string, title: string): string | undefined => {
    if (sources.length >= AGENT_MAX_SOURCES) return undefined;
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return undefined;
    seen.add(url);
    const id = `src-${sources.length}`;
    sources.push({ id, url, title: title || url, sourceKind: 'extracted' });
    return id;
  };
  for (const source of reportSources) pushSource(source.url, source.title);
  for (const passage of ordered) pushSource(passage.url, passage.title);
  if (sources.length === 0) {
    warnings.push('no admissible sources; result carries no claims');
  }

  // Claims: every claim cites >=1 source id (citation contract). Only claims
  // with verifiable source associations ship: structured report claims whose
  // ids all exist, else claims derived from fetched passages (each cites its
  // own passage source). Report sentences without structured evidence never
  // become claims — no round-robin citation.
  const claims: AgentClaimV1[] = [];
  const citedIds = sources.map((source) => source.id);
  const validIds = new Set(citedIds);
  if (citedIds.length > 0) {
    for (const candidate of structuredClaims) {
      if (claims.length >= citedIds.length * 4) break;
      if (typeof candidate?.text !== 'string' || candidate.text.trim() === '') continue;
      // Claim ceiling enforced at composition: overlong report claims clip to
      // the byte budget instead of shipping validator-rejected output.
      const clipped = truncateUtf8Bytes(candidate.text, AGENT_CLAIM_MAX_BYTES);
      if (clipped.trim() === '') continue;
      if (!Array.isArray(candidate.sourceIds) || candidate.sourceIds.length === 0) continue;
      if (!candidate.sourceIds.every((id) => typeof id === 'string' && validIds.has(id))) continue;
      claims.push({ text: clipped, sourceIds: [...candidate.sourceIds] });
    }
    if (claims.length === 0) {
      for (const passage of ordered.slice(0, citedIds.length)) {
        const first = truncateUtf8Bytes(splitClaims(passage.text)[0] ?? passage.title, AGENT_CLAIM_MAX_BYTES);
        const id = sources.find((source) => source.url === passage.url)?.id;
        if (id !== undefined) claims.push({ text: first, sourceIds: [id] });
      }
    }
  }

  return {
    version: 1,
    query: trimmed,
    reportText,
    claims,
    sources,
    warnings,
  };
}
