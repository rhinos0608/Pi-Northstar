// Strict public tool parameter schemas (no runtime behavior change).
// Each builder mirrors its internal contract vocabulary and bounds so the
// model-facing schema cannot drift from runtime validation. Registration
// wiring stays in src/index.ts until the integration task adopts these.
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { researchSourceIds } from './capabilities.js';
import {
  FETCH_ANSWER_PROMPT_MAX_CHARS,
  MAX_WEB_QUERY_LENGTH,
  RESEARCH_SEARCH_LIMIT_MAX,
  SEARCH_CATEGORY_NAMES,
  WEB_MAX_CURSOR_LENGTH,
  WEB_SEARCH_MAX_BATCH_QUERIES,
  WEB_SEARCH_MAX_DOMAINS,
} from './web/web-contract.js';
import { WEB_PROVIDER_MIN_YEAR_FROM } from './web/web-search-types.js';
import {
  ENHANCE_SELECTOR_KEYS,
  KG_ENHANCE_FIELDS,
  KG_NLP_MAX_CHARS,
  MAX_KG_CURSOR_LENGTH,
  PERSON_ONLY_KEYS,
} from './knowledge/knowledge-contract.js';

// Category names canonical in web-contract.ts (single source of truth).

/**
 * Flat web_search schema. Keep the model-facing shape as one object rather
 * than a nested request envelope or an anyOf-heavy branch union. Cross-field
 * rules (query xor queries, research-only source/cursor, category-specific
 * limit caps) are enforced by buildSearchRoute/validateWebRequest.
 */
export function buildWebSearchParameters(): TSchema {
  return Type.Object({
    query: Type.Optional(Type.String({
      minLength: 1,
      maxLength: MAX_WEB_QUERY_LENGTH,
      description: 'Single search query. Provide exactly one of query or queries.',
    })),
    queries: Type.Optional(Type.Array(
      Type.String({ minLength: 1, maxLength: MAX_WEB_QUERY_LENGTH }),
      {
        minItems: 1,
        maxItems: WEB_SEARCH_MAX_BATCH_QUERIES,
        description: 'Batch of 1..8 search queries. Provide exactly one of query or queries.',
      },
    )),
    limit: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: RESEARCH_SEARCH_LIMIT_MAX,
      description: 'Max results. Plain web search: 1..20 (default 8). category:"research": 1..30 (default 12).',
    })),
    yearFrom: Type.Optional(Type.Integer({
      minimum: WEB_PROVIDER_MIN_YEAR_FROM,
      maximum: new Date().getUTCFullYear(),
      description: 'Earliest publication year in [1900, current UTC year].',
    })),
    includeContent: Type.Optional(Type.Boolean({
      description: 'Reuse provider full content when available. Plain web search only.',
    })),
    recency: Type.Optional(StringEnum(['day', 'week', 'month', 'year'], {
      description: 'Recency filter for plain web search. Intersects with yearFrom; later bound wins.',
    })),
    domains: Type.Optional(Type.Array(Type.String(), {
      maxItems: WEB_SEARCH_MAX_DOMAINS,
      description: "Domain allow/exclude list for plain web search; '-host' excludes.",
    })),
    category: Type.Optional(StringEnum(SEARCH_CATEGORY_NAMES, {
      description: 'Optional result category. Use "research" for the academic/public-data source set.',
    })),
    source: Type.Optional(StringEnum(['all', ...researchSourceIds()], {
      description: 'Research-only source pin. Requires category:"research".',
    })),
    cursor: Type.Optional(Type.String({
      minLength: 1,
      maxLength: WEB_MAX_CURSOR_LENGTH,
      description: 'Opaque research continuation cursor. Requires category:"research", a single query, and one exact source (not "all").',
    })),
    knowledge: Type.Optional(Type.Object({
      entities: Type.Optional(Type.Boolean()),
      facts: Type.Optional(Type.Boolean()),
      topics: Type.Optional(Type.Boolean()),
      sentiment: Type.Optional(Type.Boolean()),
      enhance: Type.Optional(Type.Boolean()),
    }, {
      minProperties: 1,
      additionalProperties: false,
      description: 'Optional knowledge composition over plain web results. Not supported with category:"research"; at least one flag must be true at runtime.',
    })),
  }, {
    additionalProperties: false,
    description: 'Flat web search request. Exactly one of query or queries is required. Research-only combinations are validated at runtime.',
  });
}

/**
 * Standalone adaptive-research tool. Flat two-operation shape:
 * {query, depth?} starts a job; {jobId} polls it. Exactly one selector.
 */
export function buildAgentParameters(): TSchema {
  return Type.Object({
    query: Type.Optional(Type.String({
      minLength: 1,
      maxLength: MAX_WEB_QUERY_LENGTH,
      description: 'Start a new adaptive research job with this query.',
    })),
    depth: Type.Optional(StringEnum(['balanced', 'deep'], {
      description: 'Gather depth for a new job only (default balanced).',
    })),
    jobId: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 128,
      description: 'Poll an existing agent job by id.',
    })),
  }, {
    additionalProperties: false,
    description: 'Exactly one of query or jobId. Use {query, depth?} to start; use {jobId} to poll.',
  });
}

import {
  GRAPH_LANGUAGES,
  GRAPH_PAGE_SIZE_MAX,
  GRAPH_PAGE_SIZE_MIN,
  MAX_GRAPH_BATCH,
  MAX_GRAPH_CURSOR_LENGTH,
  MAX_GRAPH_NAME_CHARS,
  MAX_GRAPH_QUERY_CHARS,
  type GraphLanguage,
} from './graph/graph-contract.js';

/**
 * Flat graph schema. action/language-specific requiredness and forbidden
 * combinations are runtime-owned so the model sees one predictable object.
 */
export function buildGraphParameters(languages: readonly GraphLanguage[] = [...GRAPH_LANGUAGES]): TSchema {
  const queryText = (description: string): TSchema =>
    Type.String({ minLength: 1, maxLength: MAX_GRAPH_QUERY_CHARS, description });
  return Type.Object({
    action: StringEnum(['query', 'probe', 'schema'], { description: 'Graph operation.' }),
    language: StringEnum([...languages], { description: 'Configured graph language.' }),
    query: Type.Optional(queryText('Query text. Required for action:"query" and schema view:"search".')),
    queries: Type.Optional(Type.Array(queryText('Countable entity query.'), {
      minItems: 1,
      maxItems: MAX_GRAPH_BATCH,
      description: 'Probe queries, 1..32. Valid only for action:"probe".',
    })),
    pageSize: Type.Optional(Type.Integer({
      minimum: GRAPH_PAGE_SIZE_MIN,
      maximum: GRAPH_PAGE_SIZE_MAX,
      description: 'DQL query transport page size only (default 10, max 100). SPARQL rejects it.',
    })),
    cursor: Type.Optional(Type.String({
      minLength: 1,
      maxLength: MAX_GRAPH_CURSOR_LENGTH,
      description: 'DQL query cursor only; bound to query/pageSize. SPARQL rejects it.',
    })),
    view: Type.Optional(StringEnum(['types', 'fields', 'search', 'describe'], {
      description: 'Schema view. Required only for action:"schema".',
    })),
    name: Type.Optional(Type.String({
      minLength: 1,
      maxLength: MAX_GRAPH_NAME_CHARS,
      description: 'Schema type/field name for fields/describe views.',
    })),
    includeDeprecated: Type.Optional(Type.Boolean({ description: 'Schema views only.' })),
  }, {
    additionalProperties: false,
    description: 'Flat graph request. Runtime enforces action/language-specific requiredness and field combinations.',
  });
}

import {
  DESKTOP_ACTIONS,
  MAX_COORD_ABS,
  MAX_ID_LENGTH,
  MAX_SELECTOR_TEXT_LENGTH,
  MAX_TEXT_LENGTH as MAX_DESKTOP_TEXT_LENGTH,
  type DesktopField,
} from './desktop/desktop-contract.js';

const MAX_DESKTOP_TIMEOUT_MS = 60_000;

const DESKTOP_FIELDS: Record<DesktopField, TSchema> = {
  pid: Type.Integer({ minimum: 1, description: 'Target process ID from observation.' }),
  windowId: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH, description: 'Target window identifier from observation.' }),
  stateId: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH, description: 'Fresh stateId from latest observation; required for mutations.' }),
  includeScreenshot: Type.Boolean({ description: 'Attach target-window screenshot; may expose PII.' }),
  predicate: Type.Object({
    text: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_TEXT_LENGTH })),
    role: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_TEXT_LENGTH })),
  }, { additionalProperties: false, description: 'Element match: visible text and/or AX role.' }),
  text: Type.String({ minLength: 1, maxLength: MAX_DESKTOP_TEXT_LENGTH, description: 'Text to type or match (max 10k chars).' }),
  key: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH, description: 'Key to press.' }),
  x: Type.Number({ minimum: -MAX_COORD_ABS, maximum: MAX_COORD_ABS, description: 'X coordinate from observation.' }),
  y: Type.Number({ minimum: -MAX_COORD_ABS, maximum: MAX_COORD_ABS, description: 'Y coordinate from observation.' }),
  deltaX: Type.Number({ minimum: -MAX_COORD_ABS, maximum: MAX_COORD_ABS, description: 'Horizontal scroll delta.' }),
  deltaY: Type.Number({ minimum: -MAX_COORD_ABS, maximum: MAX_COORD_ABS, description: 'Vertical scroll delta.' }),
  timeoutMs: Type.Number({ minimum: 0, maximum: MAX_DESKTOP_TIMEOUT_MS, description: 'Wait budget, max 60000ms.' }),
};

/**
 * Flat desktop schema. The runtime contract table owns action-specific
 * requiredness; the model-facing schema exposes one stable object.
 */
export function buildDesktopParameters(): TSchema {
  const properties: Record<string, TSchema> = {
    action: StringEnum([...DESKTOP_ACTIONS], { description: 'Desktop action.' }),
  };
  for (const [field, schema] of Object.entries(DESKTOP_FIELDS)) {
    properties[field] = Type.Optional(schema);
  }
  return Type.Object(properties, {
    additionalProperties: false,
    description: 'Flat desktop request. Runtime enforces action-specific required and allowed fields.',
  });
}

import {
  auxSpecFor,
  canonicalActionsFor,
  MAX_SELECTOR_LENGTH as MAX_SOCIAL_SELECTOR_LENGTH,
  SOCIAL_ACTIONS,
  SOCIAL_MAX_CURSOR_LENGTH,
  SOCIAL_MAX_LIMIT,
  SOCIAL_PLATFORMS,
  type SocialAction,
  type SocialPlatform,
  type SocialSelectorField,
} from './social/social-contract.js';

// Selector/cursor length bounds canonical in social-contract.ts (single source of truth).
const SELECTOR_DESCRIPTIONS: Record<SocialSelectorField, string> = {
  query: 'Platform search query (required direct input; never derived from a URL).',
  postId: 'Post or note id directly, or a canonical URL deriving it (at least one required; enforced at runtime).',
  commentId: 'commentId direct; Reddit canonical URL can derive it; Twitter requires direct commentId',
  user: 'User handle directly, or a canonical URL deriving it (at least one required; enforced at runtime).',
  community: 'Community selector directly, or a canonical URL deriving it (at least one required; enforced at runtime).',
  topic: 'Topic id directly, or a canonical URL deriving it (at least one required; enforced at runtime).',
};

function socialActionSelectorField(field: SocialSelectorField): TSchema {
  return Type.String({ minLength: 1, maxLength: MAX_SOCIAL_SELECTOR_LENGTH, description: SELECTOR_DESCRIPTIONS[field] });
}

// Platforms advertising a canonical action. Inverted from the code-owner
// registry (SOCIAL_CANONICAL_ACTIONS via canonicalActionsFor) so the schema
// cannot drift from runtime advertisement.
function socialPlatformsFor(action: SocialAction): SocialPlatform[] {
  return SOCIAL_PLATFORMS.filter((platform) => canonicalActionsFor(platform).includes(action));
}

/**
 * Flat social schema. Platform/action compatibility, selector requiredness,
 * aux-field vocabularies, and stricter per-platform caps remain runtime-owned.
 */
export function buildSocialParameters(): TSchema {
  const sortValues = new Set<string>();
  const feedVariantValues = new Set<string>();
  for (const action of SOCIAL_ACTIONS) {
    for (const platform of socialPlatformsFor(action)) {
      const aux = auxSpecFor(platform, action);
      for (const value of aux.sort ?? []) sortValues.add(value);
      for (const value of aux.feedVariant ?? []) feedVariantValues.add(value);
    }
  }
  return Type.Object({
    platform: StringEnum([...SOCIAL_PLATFORMS], { description: 'Social platform.' }),
    action: StringEnum([...SOCIAL_ACTIONS], { description: 'Canonical read-only social action.' }),
    query: Type.Optional(socialActionSelectorField('query')),
    postId: Type.Optional(socialActionSelectorField('postId')),
    commentId: Type.Optional(socialActionSelectorField('commentId')),
    user: Type.Optional(socialActionSelectorField('user')),
    community: Type.Optional(socialActionSelectorField('community')),
    topic: Type.Optional(socialActionSelectorField('topic')),
    url: Type.Optional(Type.String({
      minLength: 1,
      description: 'Canonical platform URL that may derive post/user/community/topic selectors. Never derives search query.',
    })),
    limit: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: SOCIAL_MAX_LIMIT,
      description: `Max items 1..${SOCIAL_MAX_LIMIT}; stricter platform/action caps reject at runtime.`,
    })),
    cursor: Type.Optional(Type.String({
      minLength: 1,
      maxLength: SOCIAL_MAX_CURSOR_LENGTH,
      description: 'Opaque pagination cursor, bound to the platform/action/selectors.',
    })),
    sort: sortValues.size > 0
      ? Type.Optional(StringEnum([...sortValues], { description: 'Result ordering where supported; runtime enforces platform/action subset.' }))
      : Type.Optional(Type.String()),
    timeRange: Type.Optional(Type.String({ minLength: 1, description: 'Time filter where supported; platform-specific shape enforced at runtime.' })),
    feedVariant: feedVariantValues.size > 0
      ? Type.Optional(StringEnum([...feedVariantValues], { description: 'Feed variant where supported; runtime enforces platform/action subset.' }))
      : Type.Optional(Type.String()),
    includeReplies: Type.Optional(Type.Boolean({ description: 'Include nested replies where supported.' })),
  }, {
    additionalProperties: false,
    description: 'Flat social request. Runtime enforces platform/action compatibility, required selectors, URL derivation, and action-specific fields.',
  });
}

import {
  MAX_EXPRESSION_LENGTH,
  MAX_SCROLL_COORD,
  MAX_SELECT_VALUES,
  MAX_SELECTOR_LENGTH,
  MAX_TEXT_LENGTH as MAX_BROWSER_TEXT_LENGTH,
  MAX_URL_LENGTH as MAX_BROWSER_URL_LENGTH,
  MAX_WAIT_MS,
  MAX_COOKIES,
  MAX_BATCH_COMMANDS,
  BROWSER_ACTIONS,
  SEMANTIC_LOCATORS,
  SEMANTIC_VERBS,
} from './browser/browser-policy.js';
import {
  MAX_JOB_STEPS,
} from './browser/browser-job.js';

/**
 * Strict semanticAction: closed locator/verb enums with the runtime rules
 * encoded structurally \u2014 index required only under locator nth, value
 * required only under verb fill, name only under locator role.
 */
function semanticActionBranches(): TSchema[] {
  const query = Type.String({ minLength: 1, maxLength: MAX_BROWSER_TEXT_LENGTH });
  const exact = Type.Optional(Type.Boolean());
  const value = Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH, description: 'Fill text; required when verb is fill.' });
  const index = Type.Integer({ minimum: 0, description: 'Element index; required when locator is nth.' });
  const name = Type.String({ minLength: 1, maxLength: MAX_BROWSER_TEXT_LENGTH, description: 'Accessible name; only allowed when locator is role.' });
  const otherVerbs = SEMANTIC_VERBS.filter((verb) => verb !== 'fill');
  const nonNthLocators = SEMANTIC_LOCATORS.filter((locator) => locator !== 'nth' && locator !== 'role');
  const nthVerb = (verbName: string): TSchema =>
    Type.Object({ locator: Type.Literal('nth'), query, index, verb: Type.Literal(verbName), exact }, { additionalProperties: false });
  const roleVerb = (verbName: string): TSchema =>
    Type.Object({ locator: Type.Literal('role'), query, verb: Type.Literal(verbName), name: Type.Optional(name), exact }, { additionalProperties: false });
  const otherVerb = (verbName: string): TSchema =>
    Type.Object({ locator: StringEnum(nonNthLocators, { description: 'Semantic element locator.' }), query, verb: Type.Literal(verbName), exact }, { additionalProperties: false });
  return [
    Type.Object({ locator: Type.Literal('nth'), query, index, verb: Type.Literal('fill'), value, exact }, { additionalProperties: false }),
    ...otherVerbs.map(nthVerb),
    Type.Object({ locator: Type.Literal('role'), query, verb: Type.Literal('fill'), value, name: Type.Optional(name), exact }, { additionalProperties: false }),
    ...otherVerbs.map(roleVerb),
    Type.Object({ locator: StringEnum(nonNthLocators, { description: 'Semantic element locator.' }), query, verb: Type.Literal('fill'), value, exact }, { additionalProperties: false }),
    ...otherVerbs.map(otherVerb),
  ];
}

/**
 * Flat browser schema. The browser policy remains the authority for
 * action-specific requiredness and forbidden combinations.
 */
export function buildBrowserParameters(): TSchema {
  const selector = (description: string): TSchema =>
    Type.String({ minLength: 1, maxLength: MAX_SELECTOR_LENGTH, description });
  const text = Type.String({ minLength: 1, maxLength: MAX_BROWSER_TEXT_LENGTH });
  const job = Type.Object({
    steps: Type.Array(Type.Union([
      Type.Object({ kind: Type.Literal('open'), url: Type.String({ minLength: 1, maxLength: MAX_BROWSER_URL_LENGTH }), continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('click'), selector: selector('CSS/XPath selector to click.'), continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('fill'), selector: selector('Target selector.'), text, continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('type'), selector: selector('Target selector.'), text, continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('select'), selector: selector('Target selector.'), values: Type.Array(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH }), { minItems: 1, maxItems: MAX_SELECT_VALUES }), continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('wait'), selector: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_LENGTH })), text: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })), waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })), continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('assert'), selector: selector('Target selector to assert.'), assertText: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })), waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })), continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('snapshot'), continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('screenshot'), continueOnFailure: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    ]), { minItems: 1, maxItems: MAX_JOB_STEPS }),
    maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_JOB_STEPS })),
  }, { additionalProperties: false });
  const batch = Type.Object({
    commands: Type.Array(Type.Object({
      args: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      sensitive: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_BATCH_COMMANDS }),
    maxCommands: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BATCH_COMMANDS })),
  }, { additionalProperties: false });
  return Type.Object({
    op: Type.Optional(Type.Literal('observe', { description: 'Compact observation form. Mutually exclusive with action.' })),
    what: Type.Optional(StringEnum(['status', 'tabs', 'get_url', 'get_title', 'text', 'html', 'snapshot', 'screenshot'], { description: 'Observation target when op:"observe".' })),
    action: Type.Optional(StringEnum([...BROWSER_ACTIONS], { description: 'Browser action. Mutually exclusive with op.' })),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_BROWSER_URL_LENGTH })),
    expression: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EXPRESSION_LENGTH })),
    selector: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_LENGTH })),
    text: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })),
    compact: Type.Optional(Type.Boolean()),
    x: Type.Optional(Type.Number({ minimum: -MAX_SCROLL_COORD, maximum: MAX_SCROLL_COORD })),
    y: Type.Optional(Type.Number({ minimum: -MAX_SCROLL_COORD, maximum: MAX_SCROLL_COORD })),
    urls: Type.Optional(Type.Array(Type.String())),
    cookies: Type.Optional(Type.Array(Type.Any(), { maxItems: MAX_COOKIES })),
    values: Type.Optional(Type.Array(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH }), { minItems: 1, maxItems: MAX_SELECT_VALUES })),
    waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })),
    semanticAction: Type.Optional(Type.Union(semanticActionBranches())),
    job: Type.Optional(job),
    batch: Type.Optional(batch),
  }, {
    additionalProperties: false,
    description: 'Flat browser request. Provide either op:"observe" with what, or action with that action\'s fields. Runtime policy enforces requiredness and sensitive gates.',
  });
}

// ── kg parameters: discriminated action union from knowledge-contract vocabulary ──
// Mirrors validateKgSearch/validateKgEnhance/validateKgNlp bounds so the
// model-facing schema cannot drift from runtime validation. Search pins
// language 'dql' with integer limit 1..50; enhance keeps one Person branch and one
// Organization branch with all legitimate selectors optional (>=1 required,
// enforced at runtime; Person-only employer/title/school never advertised
// on Organization); analyze_text bounds text 1..KG_NLP_MAX_CHARS with
// ISO 639-1-or-auto language. Runtime still re-validates every request.
//
// Returns the request-body union; registration wraps it as
// Type.Object({ request: buildKgParameters() }).
const KG_PERSON_SELECTORS = [...ENHANCE_SELECTOR_KEYS, ...PERSON_ONLY_KEYS] as const;

function kgSharedSelectorFields(): Record<string, TSchema> {
  return {
    providers: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: 'Explicit provider fanout; omitted selects the highest-priority capable provider.' })),
    maxProviders: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: 'Provider fanout cap 1..8 (operator DIFFBOT_MAX_PROVIDERS wins).' })),
  };
}

function kgEnhanceModifiers(): Record<string, TSchema> {
  return {
    fields: Type.Optional(StringEnum([...KG_ENHANCE_FIELDS], { description: 'Atlas-owned portable field projection.' })),
    maxEntities: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'Max entities 1..10.' })),
    includeRelationships: Type.Optional(Type.Boolean()),
    includeEvidence: Type.Optional(Type.Boolean()),
    confidenceThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: 'Drop explicit below-threshold numerics 0..1.' })),
    ...kgSharedSelectorFields(),
  };
}

export function buildKgParameters(): TSchema {
  const properties: Record<string, TSchema> = {
    action: StringEnum(['search', 'enhance', 'analyze_text'], { description: 'Knowledge operation.' }),
    query: Type.Optional(Type.String({ minLength: 1, description: 'Entity-returning DQL query. Required for action:"search".' })),
    language: Type.Optional(Type.Union([
      Type.Literal('dql'),
      Type.Literal('auto'),
      Type.String({ pattern: '^[a-z]{2}$', minLength: 2, maxLength: 2 }),
    ], { description: 'search uses dql; analyze_text uses auto or ISO 639-1. Runtime enforces the action-specific subset.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Search result limit 1..50.' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_KG_CURSOR_LENGTH, description: 'Search cursor only.' })),
    type: Type.Optional(StringEnum(['Person', 'Organization'], { description: 'Entity type for action:"enhance".' })),
    ...kgEnhanceModifiers(),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: KG_NLP_MAX_CHARS, description: `Source text 1..${KG_NLP_MAX_CHARS} chars for analyze_text (sent with consent).` })),
    extractEntities: Type.Optional(Type.Boolean()),
    extractFacts: Type.Optional(Type.Boolean()),
    extractSentiment: Type.Optional(Type.Boolean()),
    extractTopics: Type.Optional(Type.Boolean()),
  };
  for (const field of KG_PERSON_SELECTORS) {
    properties[field] = Type.Optional(Type.String({
      minLength: 1,
      description: `Enhance selector: ${field}. Person-only selectors reject for Organization at runtime.`,
    }));
  }
  return Type.Object(properties, {
    additionalProperties: false,
    description: 'Flat kg request. Runtime enforces action-specific requiredness, selector rules, and Person/Organization field restrictions.',
  });
}

// ── flat fetch parameters; buildFetchRoute owns cross-field validation ──

export function buildFetchParameters(): TSchema {
  const liveUrl = (description: string): TSchema => Type.String({
    minLength: 1,
    pattern: '^[Hh][Tt][Tt][Pp][Ss]?://',
    description,
  });
  return Type.Object({
    url: Type.Optional(liveUrl('Single HTTP(S)/GitHub asset URL, or sitemap root when siteMap:true.')),
    urls: Type.Optional(Type.Array(liveUrl('HTTP(S)/GitHub asset URL.'), {
      minItems: 1,
      maxItems: 8,
      description: 'Per-URL reads 1..8 in input order. Mutually exclusive with url/responseId.',
    })),
    siteMap: Type.Optional(Type.Literal(true, { description: 'With url, discover same-origin URLs instead of reading page content.' })),
    query: Type.Optional(Type.String({ minLength: 1, description: 'Readable extraction query, or sitemap URL ranking query.' })),
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Readable extraction top chunks, max 20.' })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: 'Readable-mode output cap, max 50000.' })),
    mode: Type.Optional(StringEnum(['readable', 'raw', 'answer'], {
      description: 'Read mode for url/urls only. Default readable. answer requires prompt; raw forbids query/topK/maxChars/prompt.',
    })),
    prompt: Type.Optional(Type.String({
      minLength: 1,
      maxLength: FETCH_ANSWER_PROMPT_MAX_CHARS,
      description: 'Question for mode:"answer"; required only in answer mode.',
    })),
    maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: 'Sitemap page cap, max 25; valid only with siteMap:true.' })),
    responseId: Type.Optional(Type.String({ minLength: 1, description: 'Cached corpus id for retrieve/claim-check; no network.' })),
    sourceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: 'Optional cached source subset.' })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Cached retrieve offset.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: 'Cached retrieve character/item limit.' })),
    findText: Type.Optional(Type.String({ minLength: 1, description: 'Cached retrieve text search.' })),
    claims: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 20,
      description: 'Cached claim verification, 1..20 claims. Requires responseId.',
    })),
  }, {
    additionalProperties: false,
    description: 'Flat fetch request. Choose exactly one locator family: url, urls, or responseId. Runtime enforces read/sitemap/retrieve/claim-check field combinations.',
  });
}
