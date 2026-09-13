// Optional safe public-excerpt knowledge composition for web search.
// Gate: PI_SEARCH_KG_ENRICHMENT=1 plus at least one requested knowledge flag.
// Analyzes at most first three fused hits with nonempty original snippets.
// Never submits generated text, fetch content, or contact selectors.
// Suspected sensitive/personal excerpts skipped without echo (defense-in-depth,
// not proof of absence). Enhance: max three normalized Person/Organization
// entities, name plus validated public homepage only. Standalone kg modules
// unchanged; Diffbot adapters arrive via injected runtime bindings.

import { validateHttpUrl } from '../core/http.js';
import { WEB_ENTITY_CONTENT_MAX } from './web-contract.js';
import type { KgClaim, KgEntity, KgMention, KgPartition } from '../knowledge/knowledge-contract.js';
import {
  WEB_KNOWLEDGE_MAX_RESULTS,
  type WebFusedSearchHit,
  type WebKnowledgeRequest,
  type WebKnowledgeResult,
} from './web-search-types.js';

export const KG_ENRICHMENT_ENV_KEY = 'PI_SEARCH_KG_ENRICHMENT';
export const WEB_KNOWLEDGE_ENHANCE_MAX = 3;
const ERROR_MESSAGE_MAX = 500;

export type WebKnowledgeHit = Pick<WebFusedSearchHit, 'url' | 'title' | 'snippet'>;

export interface WebKnowledgeAnalyzeInput {
  text: string;
  extractEntities: boolean;
  extractFacts: boolean;
  extractTopics: boolean;
  extractSentiment: boolean;
}

export interface WebKnowledgeAnalyzeOutcome {
  entities: KgEntity[];
  mentions: KgMention[];
  facts: KgClaim[];
  topics: string[];
  sentiment?: string;
}

export interface WebKnowledgeEnhanceInput {
  type: 'Person' | 'Organization';
  selectors: { name?: string; url?: string };
  maxEntities: 1;
}

export interface WebKnowledgeEnhanceOutcome {
  entities: KgEntity[];
  claims: KgClaim[];
}

/** Runtime bindings to existing Diffbot adapters. Keeps this module decoupled: no import of standalone kg modules. */
export interface WebKnowledgeBindings {
  analyzeText(
    input: WebKnowledgeAnalyzeInput,
    ctx?: { signal?: AbortSignal },
  ): Promise<WebKnowledgeAnalyzeOutcome>;
  enhance(input: WebKnowledgeEnhanceInput, ctx?: { signal?: AbortSignal }): Promise<WebKnowledgeEnhanceOutcome>;
}

export interface ComposeWebKnowledgeInput {
  hits: ReadonlyArray<WebKnowledgeHit>;
  knowledge?: WebKnowledgeRequest;
  env: Record<string, string | undefined>;
  bindings: WebKnowledgeBindings;
  signal?: AbortSignal;
}

function parseEnvFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const clean = value.trim().toLowerCase();
  if (clean === '1' || clean === 'true') return true;
  if (clean === '0' || clean === 'false') return false;
  return undefined;
}

/** Disabled by default; malformed values fail closed (false, zero calls). */
export function isKnowledgeEnrichmentEnabled(env: Record<string, string | undefined>): boolean {
  return parseEnvFlag(env[KG_ENRICHMENT_ENV_KEY]) === true;
}

function hasRequestedFlag(knowledge: WebKnowledgeRequest): boolean {
  return (
    knowledge.entities === true ||
    knowledge.facts === true ||
    knowledge.topics === true ||
    knowledge.sentiment === true ||
    knowledge.enhance === true
  );
}

const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_LIKE = /\+?\d[\d\s().-]{6,}\d/;
const PEOPLE_CATEGORY = /categor(?:y|ies)\s*[:=]\s*["']?people\b/i;
const LINKEDIN_PROFILE = /(?:^|\.)linkedin\.com$/i;

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function pathSegments(url: string): string[] | undefined {
  try {
    return new URL(url).pathname.split('/').filter((s) => s.length > 0);
  } catch {
    return undefined;
  }
}

/** Obvious personal-profile URLs: LinkedIn /in/ or /pub/, single-segment social handles. */
export function isPersonalProfileUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  const segments = pathSegments(url) ?? [];
  if (LINKEDIN_PROFILE.test(host)) {
    return segments[0] === 'in' || segments[0] === 'pub';
  }
  if (host === 'facebook.com' || host === 'www.facebook.com') return segments.length === 1;
  if (host === 'instagram.com' || host === 'www.instagram.com') return segments.length === 1;
  if (host === 'twitter.com' || host === 'www.twitter.com' || host === 'x.com' || host === 'www.x.com') {
    return segments.length === 1;
  }
  return false;
}

/** Defense-in-depth heuristic. True never proves sensitivity; false never proves absence. */
export function isSuspectedSensitiveExcerpt(excerpt: string): boolean {
  return EMAIL_LIKE.test(excerpt) || PHONE_LIKE.test(excerpt) || PEOPLE_CATEGORY.test(excerpt);
}

function boundErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, ERROR_MESSAGE_MAX);
}

function validPublicHomepage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return validateHttpUrl(url);
  } catch {
    return undefined;
  }
}

/** Safe public projection: id/type plus name/homepage only. Strips confidence and any other fields. */
export function projectSafeEnhancedEntity(entity: KgEntity): KgEntity {
  const out: KgEntity = { entityVersion: 1, id: entity.id, type: entity.type };
  if (typeof entity.name === 'string' && entity.name.trim().length > 0) out.name = entity.name.slice(0, 8_000);
  const homepage = validPublicHomepage(entity.url);
  if (homepage !== undefined) out.url = homepage.slice(0, 2_048);
  return out;
}

function isSafeEnhanceClaim(claim: KgClaim): boolean {
  return claim.predicate === 'name' || claim.predicate === 'url';
}

/**
 * Compose optional knowledge from fused search hits. Returns null when gated
 * off (env disabled/malformed or no requested flag) having made zero binding
 * calls. Otherwise analyzes up to three safe excerpts and optionally enhances
 * up to three Person/Organization entities, preserving partial errors.
 */
export async function composeWebKnowledge(input: ComposeWebKnowledgeInput): Promise<WebKnowledgeResult | null> {
  const { hits, knowledge, env, bindings, signal } = input;
  if (!isKnowledgeEnrichmentEnabled(env)) return null;
  if (!knowledge || !hasRequestedFlag(knowledge)) return null;

  const entities: KgEntity[] = [];
  const mentions: KgMention[] = [];
  const facts: KgClaim[] = [];
  const topics: string[] = [];
  let sentiment: string | undefined;
  const sentiments = new Set<string>();
  const partitions: KgPartition[] = [];
  const skipped: WebKnowledgeResult['skipped'] = [];
  let errorCount = 0;

  const candidates: Array<{ url: string; excerpt: string }> = [];
  for (const hit of hits) {
    if (candidates.length >= WEB_KNOWLEDGE_MAX_RESULTS) break;
    const snippet = hit.snippet ?? '';
    if (snippet.trim().length === 0) {
      skipped.push({ url: hit.url, reason: 'empty_excerpt' });
      continue;
    }
    const excerpt = snippet.slice(0, WEB_ENTITY_CONTENT_MAX);
    if (isSuspectedSensitiveExcerpt(excerpt) || isPersonalProfileUrl(hit.url)) {
      skipped.push({ url: hit.url, reason: 'suspected_sensitive_or_personal' });
      continue;
    }
    candidates.push({ url: hit.url, excerpt });
  }

  const analyzeInput = {
    extractEntities: knowledge.entities === true || knowledge.enhance === true,
    extractFacts: knowledge.facts === true,
    extractTopics: knowledge.topics === true,
    extractSentiment: knowledge.sentiment === true,
  };

  for (const candidate of candidates) {
    if (signal?.aborted) break;
    try {
      const ctx = signal !== undefined ? { signal } : undefined;
      const outcome = await bindings.analyzeText({ text: candidate.excerpt, ...analyzeInput }, ctx);
      entities.push(...outcome.entities);
      mentions.push(...outcome.mentions);
      facts.push(...outcome.facts);
      for (const topic of outcome.topics) {
        if (!topics.includes(topic)) topics.push(topic);
      }
      if (typeof outcome.sentiment === 'string' && outcome.sentiment.trim().length > 0) {
        sentiments.add(outcome.sentiment);
      }
      partitions.push({
        provider: 'diffbot',
        status: outcome.entities.length > 0 || outcome.facts.length > 0 ? 'ok' : 'empty',
      });
    } catch (error) {
      errorCount += 1;
      partitions.push({
        provider: 'diffbot',
        status: 'error',
        error: { code: 'upstream_error', message: boundErrorMessage(error), retryable: false, provider: 'diffbot' },
      });
    }
  }

  if (knowledge.enhance === true && !signal?.aborted) {
    const targets = entities
      .filter((e) => (e.type === 'Person' || e.type === 'Organization') && typeof e.name === 'string' && e.name.trim().length > 0)
      .slice(0, WEB_KNOWLEDGE_ENHANCE_MAX);
    for (const target of targets) {
      if (signal?.aborted) break;
      const selectors: { name?: string; url?: string } =
        validPublicHomepage(target.url) !== undefined
          ? { name: target.name as string, url: validPublicHomepage(target.url) as string }
          : { name: target.name as string };
      try {
        const enhanceCtx = signal !== undefined ? { signal } : undefined;
        const outcome = await bindings.enhance(
          { type: target.type as 'Person' | 'Organization', selectors, maxEntities: 1 },
          enhanceCtx,
        );
        for (const entity of outcome.entities) {
          if (!entities.some((e) => e.id === entity.id)) entities.push(projectSafeEnhancedEntity(entity));
        }
        for (const claim of outcome.claims) {
          if (isSafeEnhanceClaim(claim)) facts.push(claim);
        }
        partitions.push({ provider: 'diffbot', status: 'ok' });
      } catch (error) {
        errorCount += 1;
        partitions.push({
          provider: 'diffbot',
          status: 'error',
          error: { code: 'upstream_error', message: boundErrorMessage(error), retryable: false, provider: 'diffbot' },
        });
      }
    }
  }

  const distinctSentiments = [...sentiments];
  if (knowledge.sentiment === true && distinctSentiments.length === 1) {
    sentiment = distinctSentiments[0];
  }

  const hasData = entities.length > 0 || mentions.length > 0 || facts.length > 0 || topics.length > 0;
  const status: WebKnowledgeResult['status'] = errorCount > 0 ? (hasData ? 'partial' : 'unavailable') : hasData ? 'ok' : 'empty';

  return {
    status,
    entities,
    mentions,
    facts,
    topics,
    ...(sentiment !== undefined ? { sentiment } : {}),
    partitions,
    skipped,
    salience: { status: 'unavailable', reason: 'provider_unsupported' },
  };
}
