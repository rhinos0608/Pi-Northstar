import type { BackendCallResult } from './backend.js';
import {
  analyzeTextDiffbotKg,
  DIFFBOT_KG_ADAPTER_CURSOR_V,
  DIFFBOT_KG_MAX_FROM,
  DIFFBOT_KG_PROVIDER,
  enhanceDiffbotKg,
  searchDiffbotKg,
  type DiffbotKgOutcome,
  type DiffbotKgSpend,
  type DiffbotNlpOutcome,
} from './diffbot-kg.js';
import { DiffbotError, resolveDiffbotSpend, type DiffbotSpend } from './diffbot-transport.js';
import { callGithubTool } from './github-domain.js';
import type { KgIdentitySignals } from './knowledge-normalize.js';
import { aggregateKgTextAnalysis, dedupeKgEntities, groupKgEntitiesByIdentity, partitionEnhanceClaims, rrfRankKgEntities } from './knowledge-aggregate.js';
import {
  buildKnowledgeResult,
  KgContractError,
  validateKgEnhance,
  validateKgNlp,
  validateKgSearch,
  type KgAction,
  type KgAlignedGroup,
  type KgClaim,
  type KgEntity,
  type KgEntityEvidence,
  type KgError,
  type KgPartition,
  type KgSourceOutcome,
} from './knowledge-contract.js';
import {
  decodePinnedKgCursor,
  fingerprintKgRequest,
  issueKgCursor,
  KG_MAX_PROVIDERS_CEILING,
  planExplicitProviders,
  rejectCursorForExplicitFanout,
  runKgAuto,
  runKgFanout,
  selectAutoProviders,
} from './knowledge-domain.js';
import { callGraphTool } from './graph-tools.js';
import { guardResult, northstarTextResult, textResult } from './tool-output.js';
import { wrapUntrustedText } from './untrusted-content.js';
import { searchResearchPage } from './research-sources.js';
import { callReachTool } from './reach-tools.js';
import {
  agenticBrowse,
  cacheWebSearchForRetrieve,
  dispatchFetch,
} from './native-fetch.js';
export {
  agenticBrowse,
  cacheFetchEntries,
  cacheFetchForRetrieve,
  cacheWebSearchForRetrieve,
  dispatchFetch,
  dispatchSpecializedUrl,
  parseGithubFetchUrl,
} from './native-fetch.js';
import { validateWebRequest } from './web-contract.js';
import {
  requireString,
  semanticCrawl,
  webSearch,
  type WebToolOptions,
} from './web.js';

type NativeToolName = 'web_search' | 'semantic_crawl' | 'fetch' | 'agentic_browse' | 'browse' | 'research' | 'github' | 'kg' | 'graph';

interface NativeToolOptions extends WebToolOptions {}

export async function callNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions = {},
): Promise<BackendCallResult> {
  const reachResult = await callReachTool(name, args, options);
  if (reachResult) return reachResult;

  return guardResult(await dispatchNativeTool(name, args, options), { env: options.env });
}

async function dispatchNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions,
): Promise<BackendCallResult> {
  switch (name as NativeToolName) {
    case 'web_search':
      return webSearchCached(args, options);
    case 'semantic_crawl':
      return semanticCrawl(args, options);
    case 'fetch':
      return dispatchFetch(args, options);
    case 'agentic_browse':
      return agenticBrowse(args, options);
    case 'browse':
      return agenticBrowse({ action: 'read', ...args }, options);
    case 'research':
      return research(args, options);
    case 'github':
      return github(args, options);
    case 'kg':
      return kg(args, options);
    case 'graph':
      return callGraphTool(args, { env: options.env, signal: options.signal });
    default:
      throw new Error(`Unsupported native tool: ${name}`);
  }
}




async function webSearchCached(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const result = await webSearch(args, options);
  try {
    const details = (result as { details?: { query?: unknown; results?: Array<{ title: string; url: string; snippet?: string; source?: string; backend?: string }>; responseId?: unknown } }).details;
    if (details && typeof details.query === 'string' && Array.isArray(details.results) && details.responseId === undefined) {
      const hits = details.results.map((hit) => {
        const backend = typeof hit.backend === 'string' ? hit.backend : typeof hit.source === 'string' ? hit.source : undefined;
        return { title: hit.title, url: hit.url, snippet: hit.snippet ?? '', ...(backend !== undefined ? { backend } : {}) };
      });
      const responseId = cacheWebSearchForRetrieve(details.query, hits);
      if (responseId !== undefined) return { ...result, details: { ...details, responseId } };
    }
  } catch { /* best-effort cache; search result stands */ }
  return result;
}

async function research(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'academic';
  if (action !== 'academic') throw new Error(`Native research only supports academic action, got: ${action}`);

  const query = requireString(args.query, 'query');
  const source = typeof args.source === 'string' ? args.source : 'all';
  // Reject-on-out-of-range: research limit 1-30 rejects via the web contract
  // instead of silently clamping.
  const { request: bound } = validateWebRequest({
    action: 'search',
    query,
    category: 'research',
    limit: args.limit === undefined ? 12 : (args.limit as number),
  });
  const limit = bound.limit;
  // Every advertised source dispatches to its exact native adapter via the
  // research seam; unknown sources return an explicit error envelope, never a
  // DuckDuckGo/web substitution.
  const researchPageRequest: Parameters<typeof searchResearchPage>[0] = { query, source, limit };
  if (typeof args.yearFrom === 'number') researchPageRequest.yearFrom = args.yearFrom;
  if (typeof args.cursor === 'string' && args.cursor) researchPageRequest.cursor = args.cursor;
  if (options.signal) researchPageRequest.signal = options.signal;
  if (options.env) researchPageRequest.env = options.env;
  const envelope = await searchResearchPage(researchPageRequest, { requestedAction: action });

  const entities = envelope.data.kind === 'entities' ? envelope.data.entities : [];
  const results = entities.map((entity) => ({
    title: entity.title || entity.id,
    url: entity.url,
    snippet: entity.snippet ?? '',
    source: entity.source,
  }));
  let text = results.length
    ? results.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join('\n\n')
    : `No research results for: ${query}`;
  const failedSources = [...new Set(envelope.errors.map((error) => error.source))];
  if (envelope.status === 'error' && envelope.errors[0]) {
    text = `Research error (${envelope.request.source}): ${envelope.errors[0].message}`;
  } else if (failedSources.length > 0 && results.length > 0) {
    text += `\n\nFailed sources: ${failedSources.join(', ')}.`;
  }

  return northstarTextResult(text, { query, source, results }, envelope);
}

async function github(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  // Thin delegation: validation, REST, and normalization live in github-domain.
  return callGithubTool(args, {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

const KG_ACTIONS: readonly string[] = ['search', 'enhance', 'analyze_text'];

function kgString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toKgSourceOutcome(outcome: DiffbotKgOutcome): KgSourceOutcome {
  if (!outcome.error) return { provider: outcome.provider, entities: outcome.entities, invalid: outcome.invalid };
  const { code, message, retryable } = outcome.error;
  return { provider: outcome.provider, entities: outcome.entities, invalid: outcome.invalid, error: { code, message, retryable } };
}

/** Enhance outcomes keep provider-normalized claims/evidence/signals for assembly; envelope ignores the extras. */
interface KgEnhanceSourceOutcome extends KgSourceOutcome {
  claims?: KgClaim[];
  evidence?: KgEntityEvidence[];
  signals?: KgIdentitySignals[];
}

function toKgEnhanceOutcome(outcome: DiffbotKgOutcome): KgEnhanceSourceOutcome {
  const base = toKgSourceOutcome(outcome);
  return {
    ...base,
    ...(outcome.claims !== undefined ? { claims: outcome.claims } : {}),
    ...(outcome.evidence !== undefined ? { evidence: outcome.evidence } : {}),
    ...(outcome.signals !== undefined ? { signals: outcome.signals } : {}),
  };
}

function unsupportedKgOutcome(provider: string, message: string): KgSourceOutcome {
  return { provider, error: { code: 'unsupported_option', message, retryable: false } };
}

function partitionForOutcome(outcome: KgSourceOutcome): KgPartition {
  const count = outcome.entities?.length ?? 0;
  // Mirror buildKnowledgeResult sources rows: dropped invalid rows fail the
  // partition (partial when entities survive, error otherwise). Provider
  // errors keep the existing terminal 'error' status.
  if (outcome.error !== undefined) {
    return {
      provider: outcome.provider,
      status: 'error',
      error: { ...outcome.error, provider: outcome.provider } as KgError,
    };
  }
  if ((outcome.invalid ?? 0) > 0) {
    return { provider: outcome.provider, status: count > 0 ? 'partial' : 'error' };
  }
  return { provider: outcome.provider, status: count > 0 ? 'ok' : 'empty' };
}

function kgEntitiesText(entities: ReadonlyArray<KgEntity>): string {
  return entities
    .map((entity, index) => `## ${index + 1}. ${entity.name ?? entity.id}\n${entity.url ?? entity.id}\ntype: ${entity.type}`)
    .join('\n\n');
}

function kgResultText(action: KgAction, label: string, entities: ReadonlyArray<KgEntity>, errors: ReadonlyArray<KgError>): string {
  if (entities.length > 0) return kgEntitiesText(entities);
  if (errors.length > 0 && errors[0]) return `Kg ${action} error (${errors[0].provider ?? 'kg'}): ${errors[0].message}`;
  return `No kg ${action} results for: ${label}`;
}

// Email/phone enhance selectors are PII: never echo them into user-facing
// tool text. Name/id/url labels pass through verbatim (phone-digit redaction
// would mangle ids/urls); only an embedded email is scrubbed there.
function redactKgSelectorLabel(label: string, fromSensitiveSelector: boolean): string {
  const noEmail = label.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  if (!fromSensitiveSelector) return noEmail;
  return noEmail.replace(/\+?\d[\d\s().-]{6,}\d/g, '[REDACTED_PHONE]');
}

interface KgRouting {
  outcomes: KgSourceOutcome[];
  providers: string[];
  attempted: string[];
}

async function routeKg(
  action: KgAction,
  requested: readonly string[] | undefined,
  configured: string[],
  maxProviders: number | undefined,
  execute: (provider: string) => Promise<KgSourceOutcome>,
): Promise<KgRouting> {
  if (requested !== undefined) {
    const plan = planExplicitProviders(action, requested, {
      configured,
      ...(maxProviders !== undefined ? { maxProviders } : {}),
    });
    const ran = await runKgFanout(execute, plan.runnable);
    const outcomes = [...ran, ...plan.unsupported.map((error) => unsupportedKgOutcome(error.provider ?? 'unknown', error.message))];
    return { outcomes, providers: [...requested], attempted: [...plan.runnable] };
  }
  const ordered = selectAutoProviders(action, configured);
  const { outcome, attempted } = await runKgAuto(execute, ordered);
  return { outcomes: [outcome], providers: [...attempted], attempted };
}

async function kg(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'search';
  if (!KG_ACTIONS.includes(action)) {
    throw new Error(`Native kg only supports search, enhance and analyze_text actions, got: ${action}`);
  }
  const env = options.env ?? process.env;
  // Spend resolved once per call: invalid operator config rejects before any paid call.
  const spend = resolveKgSpend(env);
  const token = env.DIFFBOT_TOKEN?.trim() ?? '';
  const configured = token ? [DIFFBOT_KG_PROVIDER as string] : [];
  const requested = Array.isArray(args.providers)
    ? (args.providers as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const cursor = kgString(args.cursor);
  rejectCursorForExplicitFanout(cursor, requested);
  // Operator cap wins: omitted maxProviders uses the configured default;
  // public/request values above it reject instead of clamping or partitioning excess.
  const publicMaxProviders = typeof args.maxProviders === 'number' ? args.maxProviders : undefined;
  if (publicMaxProviders !== undefined) {
    if (!Number.isInteger(publicMaxProviders) || publicMaxProviders < 1 || publicMaxProviders > KG_MAX_PROVIDERS_CEILING) {
      throw new KgContractError(
        'unsupported_option',
        `maxProviders out of range: expected integer 1..${KG_MAX_PROVIDERS_CEILING}`,
      );
    }
    if (publicMaxProviders > spend.maxProviders) {
      throw new KgContractError(
        'invalid_input',
        `maxProviders ${publicMaxProviders} exceeds operator cap ${spend.maxProviders}`,
      );
    }
  }
  const maxProviders = publicMaxProviders ?? spend.maxProviders;
  if (requested !== undefined && new Set(requested).size > maxProviders) {
    throw new KgContractError(
      'invalid_input',
      `${new Set(requested).size} providers requested exceeds maxProviders cap ${maxProviders}`,
    );
  }
  const ctx: { token: string; signal?: AbortSignal; spend: DiffbotKgSpend } = {
    token,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    spend: {
      searchDefault: spend.searchSize,
      searchCap: spend.searchSize,
      enhanceDefault: spend.enhanceSize,
      enhanceCap: spend.enhanceSize,
      nlpMaxChars: spend.nlpMaxChars,
    },
  };
  if (action === 'search') return kgSearch(args, { env, ctx, spend, configured, requested, cursor, maxProviders });
  if (action === 'enhance') return kgEnhance(args, { env, ctx, spend, configured, requested, maxProviders });
  return kgAnalyzeText(args, { env, ctx, spend, configured, requested, maxProviders });
}

interface KgCallContext {
  env: Record<string, string | undefined>;
  ctx: { token: string; signal?: AbortSignal; spend: DiffbotKgSpend };
  spend: DiffbotSpend;
  configured: string[];
  requested: string[] | undefined;
  cursor?: string | undefined;
  maxProviders: number;
}

/** Resolve DIFFBOT_* spend once; invalid config becomes a contract rejection, never a paid call. */
function resolveKgSpend(env: Record<string, string | undefined>): DiffbotSpend {
  try {
    return resolveDiffbotSpend(env);
  } catch (error) {
    if (error instanceof DiffbotError) throw new KgContractError('unsupported_option', error.message);
    throw error;
  }
}

function throwKgContract(code: KgError['code'], message: string): never {
  throw new KgContractError(code, message);
}

async function kgSearch(args: Record<string, unknown>, call: KgCallContext): Promise<BackendCallResult> {
  const validated = validateKgSearch({ query: args.query, language: args.language ?? 'dql', limit: args.limit });
  if (!validated.ok) throwKgContract(validated.code, validated.message);
  const query = (validated as { query: string }).query;
  const limit = (validated as { limit?: number }).limit;
  // Omitted limit uses the operator-configured search default; the adapter
  // rejects explicit values above the operator cap without a paid call.
  const pageSize = limit ?? call.spend.searchSize;
  const fingerprint = fingerprintKgRequest({ action: 'search', query, limit: pageSize, providers: call.requested ?? 'auto' });
  let from = 0;
  if (call.cursor !== undefined && call.requested === undefined) {
    const ordered = selectAutoProviders('search', call.configured);
    const pinned = decodePinnedKgCursor(call.cursor, {
      provider: ordered[0] ?? DIFFBOT_KG_PROVIDER,
      fingerprint,
      adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V,
    });
    const rawFrom = pinned.state['from'];
    if (typeof rawFrom !== 'number' || !Number.isInteger(rawFrom) || rawFrom < 0) {
      throw new KgContractError('cursor_invalid', 'Cursor state.from must be an integer >= 0.');
    }
    if (rawFrom > DIFFBOT_KG_MAX_FROM || rawFrom + pageSize > DIFFBOT_KG_MAX_FROM) {
      throw new KgContractError(
        'cursor_invalid',
        `Cursor state.from out of range: must satisfy from <= ${DIFFBOT_KG_MAX_FROM} and from+size <= ${DIFFBOT_KG_MAX_FROM}.`,
      );
    }
    from = rawFrom;
  }
  const { outcomes, providers } = await routeKg('search', call.requested, call.configured, call.maxProviders, async (provider) => {
    if (provider !== DIFFBOT_KG_PROVIDER) return unsupportedKgOutcome(provider, `Unknown kg provider: ${provider}.`);
    return toKgSourceOutcome(await searchDiffbotKg({ query, language: 'dql', limit: pageSize, from }, call.ctx));
  });
  const rawEntities = outcomes.flatMap((outcome) => (outcome.entities ? [...outcome.entities] : []));
  // Every provider ranking aggregates through RRF (identity-aware fusion,
  // first copy kept); a single ranking keeps fetch order by construction.
  const entities = rrfRankKgEntities(
    outcomes.map((outcome) => (outcome.entities ? [...outcome.entities] : [])),
  ).map((entry) => entry.item);
  // Single-provider auto mode pages by offset; explicit fanout is one bounded page.
  const single = call.requested === undefined && outcomes.length === 1 && outcomes[0] !== undefined;
  const hasMore = single && rawEntities.length >= pageSize && pageSize > 0 && from + pageSize < DIFFBOT_KG_MAX_FROM;
  const nextCursor = single && hasMore && outcomes[0]
    ? issueKgCursor({
      provider: outcomes[0].provider,
      fingerprint,
      adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V,
      state: { from: from + pageSize },
      fanout: false,
    })
    : undefined;
  const envelope = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search', providers },
    outcomes,
    data: { kind: 'search', entities },
    pagination: {
      supported: single,
      limit: pageSize,
      ...(nextCursor !== undefined ? { hasMore: true as const, nextCursor } : { hasMore: false as const }),
    },
  });
  const text = kgResultText('search', query, entities, envelope.errors);
  return textResult(wrapUntrustedText(text, { source: 'kg' }), { action: 'search', query, providers, knowledge: envelope });
}

const KG_ENHANCE_PASSTHROUGH = [
  'id', 'name', 'url', 'email', 'phone', 'location', 'description',
  'employer', 'title', 'school', 'fields', 'maxEntities',
  'includeRelationships', 'includeEvidence', 'confidenceThreshold',
] as const;

async function kgEnhance(args: Record<string, unknown>, call: KgCallContext): Promise<BackendCallResult> {
  const input: Record<string, unknown> = { type: args.type };
  for (const key of KG_ENHANCE_PASSTHROUGH) {
    if (args[key] !== undefined) input[key] = args[key];
  }
  const validated = validateKgEnhance(input);
  if (!validated.ok) throwKgContract(validated.code, validated.message);
  const { outcomes, providers } = await routeKg('enhance', call.requested, call.configured, call.maxProviders, async (provider) => {
    if (provider !== DIFFBOT_KG_PROVIDER) return unsupportedKgOutcome(provider, `Unknown kg provider: ${provider}.`);
    return toKgEnhanceOutcome(await enhanceDiffbotKg(input, call.ctx));
  });
  const enhanceOutcomes = outcomes as KgEnhanceSourceOutcome[];
  const inputs = enhanceOutcomes.flatMap((outcome) =>
    (outcome.entities ?? []).map((entity, index) => ({
      entity,
      provider: outcome.provider,
      ...(outcome.signals?.[index] !== undefined ? { signals: outcome.signals[index] as KgIdentitySignals } : {}),
    })),
  );
  const entities = dedupeKgEntities(inputs).map((member) => member.entity);
  // Conservative alignment: members grouped without adjudication; public
  // records carry basis/strength only (alignment confidence never computed).
  // Internal identity keys stay private: public groups use opaque
  // response-local deterministic-by-order ids (alignment:1, ...).
  const internalGroups = groupKgEntitiesByIdentity(inputs);
  const publicIdByKey = new Map<string, string>();
  internalGroups.forEach((group, index) => {
    publicIdByKey.set(group.key, `alignment:${index + 1}`);
  });
  const groups: KgAlignedGroup[] = internalGroups.map((group) => ({
    id: publicIdByKey.get(group.key) ?? 'alignment:0',
    basis: group.basis,
    strength: group.strength,
    ...(group.alignmentConfidence !== undefined ? { alignmentConfidence: group.alignmentConfidence } : {}),
    members: group.members.map((member) => ({ entity: member.entity, provider: member.provider })),
  }));
  // Provider-normalized claims keep trace tags; partition surfaces real
  // conflicts while preserving every input row. Partitions mirror outcomes.
  const allClaims: KgClaim[] = enhanceOutcomes.flatMap((outcome) =>
    (outcome.claims ?? []).map((claim) =>
      claim.provider === undefined ? { ...claim, provider: outcome.provider } : claim,
    ),
  );
  // Aligned subjects share one partition key: remap each claim's raw
  // provider-native subjectId to its opaque public group id so cross-row
  // conflicts (e.g. same canonical_url, different diffbotUri) compare.
  const subjectToGroup = new Map<string, string>();
  for (const group of internalGroups) {
    const publicId = publicIdByKey.get(group.key) ?? 'alignment:0';
    for (const member of group.members) {
      if (!subjectToGroup.has(member.entity.id)) subjectToGroup.set(member.entity.id, publicId);
    }
  }
  const alignedClaims: KgClaim[] = allClaims.map((claim) => {
    const key = subjectToGroup.get(claim.subjectId);
    return key !== undefined && key !== claim.subjectId ? { ...claim, subjectId: key } : claim;
  });
  const { claims, conflicts } = partitionEnhanceClaims(alignedClaims);
  const seenEvidence = new Set<string>();
  const evidence: KgEntityEvidence[] = [];
  for (const outcome of enhanceOutcomes) {
    for (const record of outcome.evidence ?? []) {
      if (seenEvidence.has(record.entityId)) continue;
      seenEvidence.add(record.entityId);
      evidence.push(record);
    }
  }
  const partitions = outcomes.map(partitionForOutcome);
  const envelope = buildKnowledgeResult({
    request: { tool: 'kg', action: 'enhance', providers },
    outcomes,
    data: { kind: 'enhance', entities, claims, conflicts, partitions, groups, evidence },
  });
  const emailSelector = kgString(args.email);
  const phoneSelector = emailSelector === undefined ? kgString(args.phone) : undefined;
  const rawLabel = kgString(args.name) ?? kgString(args.id) ?? kgString(args.url) ?? emailSelector ?? phoneSelector ?? 'selectors';
  const label = redactKgSelectorLabel(rawLabel, rawLabel === emailSelector || rawLabel === phoneSelector);
  const text = kgResultText('enhance', label, entities, envelope.errors);
  return textResult(wrapUntrustedText(text, { source: 'kg' }), { action: 'enhance', providers, knowledge: envelope });
}

async function kgAnalyzeText(args: Record<string, unknown>, call: KgCallContext): Promise<BackendCallResult> {
  const validated = validateKgNlp({
    text: args.text,
    ...(args.extractEntities !== undefined ? { extractEntities: args.extractEntities } : {}),
    ...(args.extractFacts !== undefined ? { extractFacts: args.extractFacts } : {}),
    ...(args.extractSentiment !== undefined ? { extractSentiment: args.extractSentiment } : {}),
    ...(args.extractTopics !== undefined ? { extractTopics: args.extractTopics } : {}),
    ...(args.language !== undefined ? { language: args.language } : {}),
  });
  if (!validated.ok) throwKgContract(validated.code, validated.message);
  const nlp = validated as { text: string };
  const nlpOutcomes: DiffbotNlpOutcome[] = [];
  const { outcomes, providers } = await routeKg('analyze_text', call.requested, call.configured, call.maxProviders, async (provider) => {
    if (provider !== DIFFBOT_KG_PROVIDER) return unsupportedKgOutcome(provider, `Unknown kg provider: ${provider}.`);
    const outcome = await analyzeTextDiffbotKg({ text: nlp.text, ...pickNlpFlags(args) }, call.ctx);
    nlpOutcomes.push(outcome);
    return toKgSourceOutcome(outcome);
  });
  const partitions = outcomes.map(partitionForOutcome);
  const aggregated = aggregateKgTextAnalysis({
    text: nlp.text,
    entities: outcomes.flatMap((outcome) => (outcome.entities ? [...outcome.entities] : [])),
    mentions: nlpOutcomes.flatMap((outcome) => outcome.mentions),
    facts: nlpOutcomes.flatMap((outcome) => outcome.facts),
    topics: nlpOutcomes.flatMap((outcome) => outcome.topics),
    sentiments: nlpOutcomes.map((outcome) => outcome.sentiment).filter((entry): entry is string => typeof entry === 'string'),
    partitions,
  });
  const envelope = buildKnowledgeResult({
    request: { tool: 'kg', action: 'analyze_text', providers },
    outcomes,
    data: {
      kind: 'analyze_text',
      entities: aggregated.entities,
      mentions: aggregated.mentions,
      facts: aggregated.facts,
      topics: aggregated.topics,
      ...(aggregated.sentiment !== undefined ? { sentiment: aggregated.sentiment } : {}),
      partitions: aggregated.partitions,
    },
  });
  const text = kgResultText('analyze_text', `${nlp.text.length} chars`, aggregated.entities, envelope.errors);
  return textResult(wrapUntrustedText(text, { source: 'kg' }), { action: 'analyze_text', providers, knowledge: envelope });
}

function pickNlpFlags(args: Record<string, unknown>): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const key of ['extractEntities', 'extractFacts', 'extractSentiment', 'extractTopics', 'language'] as const) {
    if (args[key] !== undefined) flags[key] = args[key];
  }
  return flags;
}
