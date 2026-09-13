// Compat search/citation/source-check text renderer (upstream v0.29 parity).
//
// Pure functions only: no providers, no Pi runtime, no network, no disk.
// Semantics reimplemented from pinned upstream commit
// 192ac1875e3b8f88c78953dbc314949ec9fcaa27 (index.ts formatSearchSummary /
// formatSourceCheckResult / multi-query assembly, perplexity.ts
// citationsToKeep); no verbatim upstream copy. Existing Northstar
// presentation (formatWebResults / presentPageText) stays untouched.

import type {
  WebAccessProviderFailure,
  WebAccessProviderResponse,
  WebAccessQueryResult,
  WebAccessSearchHit,
} from './web-access-contract.js';
import { WEB_ACCESS_RETRIEVAL_MAX_CHARS } from './web-access-contract.js';

/** Hard ceiling on kept citations, mirroring upstream numResults clamp. */
export const WEB_ACCESS_MAX_CITATIONS = 20;

/**
 * Preserve citation numbering by keeping the prefix through the highest
 * cited `[N]` index, capped at 20 and floored at numResults.
 */
export function citationsToKeepWebAccess(answer: string, available: number, numResults: number): number {
  let highestCited = 0;
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > highestCited) highestCited = n;
  }
  return Math.min(available, WEB_ACCESS_MAX_CITATIONS, Math.max(numResults, highestCited));
}

/** Answer-then-numbered-Sources body. Empty results mirror upstream wording. */
export function formatWebAccessSearchSummary(results: WebAccessSearchHit[], answer = ''): string {
  if (results.length === 0) {
    return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : 'No results found.';
  }
  let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : '';
  output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n\n');
  return output;
}

/** One `## Provider: <id>` section per response, in input order. */
export function formatWebAccessProviderSections(responses: WebAccessProviderResponse[]): string {
  return responses.map((r) => `## Provider: ${r.provider}\n\n${formatWebAccessSearchSummary(r.results, r.answer ?? '')}`).join('\n\n');
}

export interface WebAccessMultiQueryTextOptions {
  results: WebAccessQueryResult[];
  /** Failures outside per-query results (provider array / `all` fanout). */
  providerFailures?: WebAccessProviderFailure[] | undefined;
  responseId?: string | undefined;
  /** Null disables the retrieval hint (tool not registered). */
  getSearchContentTool?: string | null | undefined;
}

function failureMessage(failure: WebAccessProviderFailure): string {
  return failure.message;
}

/** Multi-query compat text: per-query header, summary or error, failures, id. */
export function formatWebAccessMultiQueryText(options: WebAccessMultiQueryTextOptions): string {
  const { results, providerFailures = [], responseId, getSearchContentTool } = options;
  let output = '';
  for (const entry of results) {
    if (results.length > 1) output += `## Query: "${entry.query}"\n\n`;
    if (entry.error) output += `Error: ${failureMessage(entry.error)}\n\n`;
    else output += `${formatWebAccessSearchSummary(entry.response.results, entry.response.answer ?? '')}\n\n`;
  }
  if (providerFailures.length > 0) {
    output += '## Provider errors\n\n';
    for (const failure of providerFailures) {
      output += `- ${failure.provider}: ${failureMessage(failure)}\n`;
    }
    output += '\n';
  }
  if (responseId && getSearchContentTool) {
    output += `---\nResults stored as responseId "${responseId}". Use ${getSearchContentTool}({ responseId: "${responseId}", queryIndex: 0 }) to retrieve them.`;
  }
  return output.trim();
}

/** Single fused hit: rank is its 1-based fused order (contributor rank). */
export interface WebAccessFusedHit {
  title: string;
  url: string;
  snippet?: string | undefined;
}

export interface WebAccessFusedFailure {
  provider: string;
  message: string;
}

export interface WebAccessFusedQueryInput {
  query: string;
  queryIndex: number;
  hits: WebAccessFusedHit[];
  /** Fused contributors in merge order: output-visible provenance only. */
  providers: string[];
  failures?: WebAccessFusedFailure[] | undefined;
  answer?: string | undefined;
  inlineContent?: string | undefined;
  /** Default false: content section renders only when explicitly requested. */
  includeContent?: boolean | undefined;
  maxChars?: number | undefined;
}

function safeFailureLine(failure: WebAccessFusedFailure): string {
  return `- ${failure.provider}: ${failure.message.slice(0, 500)}`;
}

/**
 * Fused per-query text: answer, numbered citations (rank = fused order),
 * `Providers:` provenance line, safe partial-failure lines, and an optional
 * bounded `Content:` section (includeContent only). Pure; no network.
 */
export function formatWebAccessFusedQueryText(entry: WebAccessFusedQueryInput): string {
  const lines: string[] = [];
  if (entry.answer && entry.answer.length > 0) lines.push(entry.answer);
  if (entry.hits.length === 0) {
    lines.push('No results found.');
  } else {
    const cites = entry.hits.map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}`);
    lines.push(cites.join('\n\n'));
  }
  if (entry.providers.length > 0) lines.push(`Providers: ${entry.providers.join(', ')}`);
  const failures = entry.failures ?? [];
  if (failures.length > 0) {
    lines.push('Partial failures:');
    for (const failure of failures) lines.push(safeFailureLine(failure));
  }
  let output = lines.join('\n\n');
  if (entry.includeContent === true && entry.inlineContent && entry.inlineContent.length > 0) {
    output += `\n\nContent:\n${entry.inlineContent}`;
  }
  const cap = entry.maxChars ?? WEB_ACCESS_RETRIEVAL_MAX_CHARS;
  if (output.length <= cap) return output;
  return truncateWebAccessText(output, cap).text;
}

export interface WebAccessFusedBatchOptions {
  results: WebAccessFusedQueryInput[];
  /** Failures outside per-query results (provider array / `all` fanout). */
  providerFailures?: WebAccessFusedFailure[] | undefined;
  responseId?: string | undefined;
  /** Null disables the retrieval hint (tool not registered). */
  getSearchContentTool?: string | null | undefined;
  maxChars?: number | undefined;
}

/**
 * Batch text in per-query input order (sorted by queryIndex, stable): one
 * `## Query:` section per query, batch-level failures, then a single bounded
 * truncation of the body with the retrieval hint appended after truncation
 * so the hint is never cut and output never exceeds maxChars.
 */
export function formatWebAccessFusedBatchText(options: WebAccessFusedBatchOptions): string {
  const { providerFailures = [], responseId, getSearchContentTool } = options;
  const cap = options.maxChars ?? WEB_ACCESS_RETRIEVAL_MAX_CHARS;
  const hint =
    responseId && getSearchContentTool
      ? `\n\n---\nResults stored as responseId "${responseId}". Use ${getSearchContentTool}({ responseId: "${responseId}", queryIndex: 0 }) to retrieve them.`
      : '';
  const ordered = [...options.results].sort((a, b) => a.queryIndex - b.queryIndex);
  const parts: string[] = [];
  for (const entry of ordered) {
    const head = ordered.length > 1 ? `## Query: "${entry.query}"\n\n` : '';
    parts.push(`${head}${formatWebAccessFusedQueryText({ ...entry, maxChars: entry.maxChars ?? options.maxChars })}`);
  }
  let body = parts.join('\n\n');
  if (providerFailures.length > 0) {
    body += '\n\n## Provider errors\n\n';
    body += providerFailures.map(safeFailureLine).join('\n');
  }
  const budget = cap - hint.length;
  if (budget < 1) return truncateWebAccessText(hint.trim(), cap).text;
  if (body.length <= budget) return `${body}${hint}`.trim();
  return `${truncateWebAccessText(body, budget).text}${hint}`.trim();
}

/** Bound cached-corpus retrieve text to maxChars with an in-budget marker. */
export function formatWebAccessRetrieveText(text: string, maxChars: number = WEB_ACCESS_RETRIEVAL_MAX_CHARS): string {
  return truncateWebAccessText(text, maxChars).text;
}

export interface WebAccessTruncatedText {
  text: string;
  truncated: boolean;
  shown: number;
  total: number;
}

function truncationMarker(shown: number, total: number): string {
  return `\n\n[truncated: showing ${shown} of ${total} chars]`;
}

/** Bound rendered text to maxChars with an in-budget truncation marker. */
export function truncateWebAccessText(text: string, maxChars: number): WebAccessTruncatedText {
  if (!Number.isInteger(maxChars) || (maxChars as number) < 1) {
    throw new RangeError('maxChars must be a positive integer');
  }
  const cap = maxChars as number;
  const total = text.length;
  if (total <= cap) return { text, truncated: false, shown: total, total };
  const worst = truncationMarker(cap, total).length;
  if (cap <= worst) {
    return { text: truncationMarker(0, total).slice(0, cap), truncated: true, shown: 0, total };
  }
  const shown = cap - worst;
  return { text: `${text.slice(0, shown)}${truncationMarker(shown, total)}`, truncated: true, shown, total };
}

export interface WebAccessSourceCheckSource {
  rank: number;
  url: string;
  title: string;
  quality: string;
}

export interface WebAccessSourceCheckClaim {
  status: string;
  rationale: string;
  confidence: number;
  supporting_passages: string[];
  contradicting_passages: string[];
}

export interface WebAccessSourceCheckArtifact {
  id: string;
  query: string;
  sources: WebAccessSourceCheckSource[];
  claims?: WebAccessSourceCheckClaim[] | undefined;
  errors?: Array<{ query: string; error: string }> | undefined;
}

/** `# Source check` artifact renderer with heuristic status + passage cites. */
export function formatWebAccessSourceCheck(
  artifact: WebAccessSourceCheckArtifact,
  getSearchContentTool: string | null = 'get_search_content',
): string {
  const lines: string[] = [`# Source check: ${artifact.query}`, ''];
  const assessment = artifact.claims?.[0];
  if (assessment) {
    lines.push(`**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`);
    lines.push(`**Rationale:** ${assessment.rationale}`);
    if (assessment.supporting_passages.length > 0) {
      lines.push(`**Supporting passages:** ${assessment.supporting_passages.join(', ')}`);
    }
    if (assessment.contradicting_passages.length > 0) {
      lines.push(`**Contradicting passages:** ${assessment.contradicting_passages.join(', ')}`);
    }
    lines.push('');
  }
  if (artifact.sources.length > 0) {
    lines.push('## Sources');
    for (const source of artifact.sources) {
      lines.push(`${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`);
    }
    lines.push('');
  }
  if (artifact.errors?.length) {
    lines.push(`Search errors: ${artifact.errors.map((e) => `${e.query}: ${e.error}`).join('; ')}`);
  }
  lines.push(
    getSearchContentTool
      ? `Artifact responseId: ${artifact.id} (retrievable via ${getSearchContentTool}; heuristic assessment, not factual adjudication).`
      : `Artifact responseId: ${artifact.id}. Content retrieval is not registered.`,
  );
  return lines.join('\n');
}
