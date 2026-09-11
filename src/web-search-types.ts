// Frozen shared web-search contracts (approved implementation plans).
// Environment-only selection/AI policy; no model-facing provider/budget/AI flags.
// Backend provenance retained. Canonical WebArticleV1 untouched — fused hits and
// generated text stay in legacy detail partitions beside details.northstar.

import type { DnsLookup } from './network-policy.js';
import type { KgClaim, KgEntity, KgMention, KgPartition } from './knowledge-contract.js';

export const WEB_SEARCH_PROVIDER_IDS = [
  'tavily',
  'exa',
  'brave',
  'diffbot',
  'firecrawl',
  'jina',
  'searxng',
  'ollama-search',
  'duckduckgo',
  'codex',
] as const;

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

export interface WebProviderSearchInput {
  query: string;
  limit: number;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  nativeAi: {
    summaries: boolean;
    answers: boolean;
  };
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  backend: WebSearchProviderId;
}

export interface WebSearchContributor {
  backend: WebSearchProviderId;
  rank: number;
}

export interface WebFusedSearchHit extends WebSearchHit {
  rrfScore: number;
  contributors: WebSearchContributor[];
}

export type WebGeneratedText =
  | {
      kind: 'summary';
      backend: WebSearchProviderId;
      url: string;
      text: string;
      provenance: {
        kind: 'result_url';
        urls: [string];
      };
      claimCitations: false;
    }
  | {
      kind: 'answer';
      backend: WebSearchProviderId;
      text: string;
      provenance: {
        kind: 'supporting_result_set';
        urls: string[];
      };
      claimCitations: false;
    };

export interface WebProviderSearchOutput {
  backend: WebSearchProviderId;
  hits: WebSearchHit[];
  generatedText: WebGeneratedText[];
}

export interface WebSearchAdapter {
  readonly id: WebSearchProviderId;
  configured(env: Record<string, string | undefined>): boolean;
  search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput>;
}

export interface WebProviderFailure {
  backend: WebSearchProviderId;
  code: 'timeout' | 'aborted' | 'upstream_error' | 'invalid_response' | 'response_too_large';
  message: string;
  retryable: boolean;
}

export interface WebSearchExecution {
  selected: WebSearchProviderId[];
  runnable: WebSearchProviderId[];
  unavailable: WebSearchProviderId[];
  results: WebFusedSearchHit[];
  generatedText: WebGeneratedText[];
  failures: WebProviderFailure[];
}

export interface WebKnowledgeRequest {
  entities?: boolean;
  facts?: boolean;
  topics?: boolean;
  sentiment?: boolean;
  enhance?: boolean;
}

export interface WebKnowledgeResult {
  status: 'ok' | 'empty' | 'partial' | 'unavailable';
  entities: KgEntity[];
  mentions: KgMention[];
  facts: KgClaim[];
  topics: string[];
  sentiment?: string;
  partitions: KgPartition[];
  skipped: Array<{
    url: string;
    reason: 'suspected_sensitive_or_personal' | 'empty_excerpt';
  }>;
  salience: {
    status: 'unavailable';
    reason: 'provider_unsupported';
  };
}

export interface WebFetchAdapterInput {
  url: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  lookup?: DnsLookup;
  timeoutMs: number;
}

export interface WebFetchedPage {
  url: string;
  title: string;
  content: string;
  backend: 'firecrawl' | 'jina';
  externalProcessing: true;
  generatedText: WebGeneratedText[];
}

export interface WebFetchAdapter {
  readonly id: 'firecrawl' | 'jina';
  configured(env: Record<string, string | undefined>): boolean;
  fetch(input: WebFetchAdapterInput): Promise<WebFetchedPage>;
}

export const WEB_REPORT_PROVIDER_IDS = ['tavily'] as const;

export type WebReportProviderId = (typeof WEB_REPORT_PROVIDER_IDS)[number];

export interface WebReportSource {
  url: string;
  title: string;
}

export interface WebReportResult {
  provider: WebReportProviderId;
  text: string;
  sources: WebReportSource[];
}

/** Provider-neutral terminal failure marker for report-adapter errors. */
export interface TerminalReportError extends Error {
  terminal: true;
}

export function terminalReportError(message: string): TerminalReportError {
  return Object.assign(new Error(message), { terminal: true as const });
}

export function isTerminalReportError(error: unknown): boolean {
  return error instanceof Error && (error as { terminal?: unknown }).terminal === true;
}

export const DEFAULT_WEB_SEARCH_PROVIDER_ORDER: readonly WebSearchProviderId[] = [
  'tavily',
  'exa',
  'brave',
  'diffbot',
  'firecrawl',
  'jina',
  'searxng',
  'ollama-search',
  'duckduckgo',
];

export const DEFAULT_WEB_SEARCH_PROVIDER_COUNT = 3;
export const MAX_WEB_SEARCH_PROVIDER_COUNT = 8;
export const DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS = 12_000;
export const MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS = 1_000;
export const MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS = 30_000;
export const WEB_GENERATED_TEXT_MAX_CHARS = 8_000;
export const WEB_GENERATED_TEXT_MAX_ITEMS = 32;
export const WEB_KNOWLEDGE_MAX_RESULTS = 3;
