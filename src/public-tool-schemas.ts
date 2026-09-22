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
  WEB_SEARCH_LIMIT_MAX,
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

function webFilterFields(options?: { agent?: boolean; limitMax?: number; researchOnly?: boolean }): Record<string, TSchema> {
  const fields: Record<string, TSchema> = {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: options?.limitMax ?? RESEARCH_SEARCH_LIMIT_MAX, description: 'Max results: plain default 8 max 20; research default 12 max 30. Out-of-range rejected, never clamped.' })),
    yearFrom: Type.Optional(Type.Integer({ minimum: WEB_PROVIDER_MIN_YEAR_FROM, maximum: new Date().getUTCFullYear(), description: 'Earliest year in [1900, current UTC year].' })),
  };
  // includeContent/recency/domains refine plain search only: the research
  // route (buildResearchRoute) forwards query/source/limit/yearFrom/cursor
  // and the research backend has no content/recency/domain inputs, so the
  // research branches must not advertise them (silent drop otherwise).
  if (options?.researchOnly !== true) {
    fields.includeContent = Type.Optional(Type.Boolean({ description: 'Reuse full content when providers return it (cost-gated); default false. Search-only.' }));
    fields.recency = Type.Optional(StringEnum(['day', 'week', 'month', 'year'], { description: 'Recency filter; intersects with yearFrom (later bound wins). Search-only.' }));
    fields.domains = Type.Optional(Type.Array(Type.String(), { maxItems: WEB_SEARCH_MAX_DOMAINS, description: "Domain allow/exclude list, '-host' excludes. Search-only." }));
  }
  if (options?.agent !== true) {
    if (options?.researchOnly === true) {
      // Research branches pin category; source is research-only; knowledge is
      // web-only (route rejects it with research categories) so it is omitted.
      fields.category = Type.Literal('research', { description: 'Research category pin for the research limit cap (30).' });
      fields.source = Type.Optional(StringEnum(['all', ...researchSourceIds()], { description: 'Research-only source pin (default all). Cursor needs one exact source, not all.' }));
    } else {
      // Plain branches: category excludes research (research matches the
      // researchOnly branches); source is research-only so it is omitted;
      // knowledge stays (web-only composition).
      fields.category = Type.Optional(StringEnum(SEARCH_CATEGORY_NAMES.filter((name) => name !== 'research'), { description: 'Result set: plain web discovery, or "research" for the 12 academic/public-data sources. mode "agent" rejects category "research".' }));
      fields.knowledge = Type.Optional(Type.Object({
        entities: Type.Optional(Type.Boolean()),
        facts: Type.Optional(Type.Boolean()),
        topics: Type.Optional(Type.Boolean()),
        sentiment: Type.Optional(Type.Boolean()),
        enhance: Type.Optional(Type.Boolean()),
      }, { minProperties: 1, additionalProperties: false, description: 'Optional knowledge composition over top results. Requires PI_SEARCH_KG_ENRICHMENT=1 plus at least one true flag (all-false stays runtime-rejected). Not supported with category "research".' }));
    }
  }
  return fields;
}

/**
 * Strict web_search parameters: single {query} | batch {queries[1..8]} |
 * agent {query, mode:"agent"}. Plain and research searches branch on the
 * limit cap (20 vs 30, matching runtime) so out-of-range values reject at
 * schema validation instead of runtime.
 */
export function buildWebSearchParameters(): TSchema {
  const queryField = Type.String({ minLength: 1, maxLength: MAX_WEB_QUERY_LENGTH, description: 'Single search query. Provide exactly one of query (single/agent) or queries (batch, 1..8).' });
  const batchField = Type.Array(Type.String({ minLength: 1, maxLength: MAX_WEB_QUERY_LENGTH }), { minItems: 1, maxItems: WEB_SEARCH_MAX_BATCH_QUERIES, description: 'Batch queries 1..8, fused in order through the canonical web runtime (one RRF pass over per-query rankings).' });
  const cursorField = Type.String({ minLength: 1, maxLength: WEB_MAX_CURSOR_LENGTH, description: 'Opaque research continuation cursor. Single query + category "research" + one exact source only.' });
  return Type.Union([
    Type.Object({ query: queryField, ...webFilterFields({ limitMax: WEB_SEARCH_LIMIT_MAX }) }, { additionalProperties: false, description: 'Single-query web search.' }),
    Type.Object({ query: queryField, ...webFilterFields({ limitMax: RESEARCH_SEARCH_LIMIT_MAX, researchOnly: true }) }, { additionalProperties: false, description: 'Single-query research search (category research, limit max 30).' }),
    Type.Object({
      query: queryField,
      ...webFilterFields({ limitMax: RESEARCH_SEARCH_LIMIT_MAX, researchOnly: true }),
      category: Type.Literal('research', { description: 'Research category pin for the research limit cap (30).' }),
      source: StringEnum(researchSourceIds(), { description: 'One exact research source; cursor continuations reject "all".' }),
      cursor: cursorField,
    }, { additionalProperties: false, description: 'Research continuation (single query + category research + exact source + cursor).' }),
    Type.Object({
      queries: batchField,
      ...webFilterFields({ limitMax: WEB_SEARCH_LIMIT_MAX }),
    }, { additionalProperties: false, description: 'Batch web search (1..8 queries).' }),
    // No batch-research branch: the router (buildSearchRoute) rejects
    // multi-query research (queries batch is not supported with category
    // "research": pass a single query), so the schema must not advertise it.
    Type.Object({
      query: queryField,
      mode: Type.Literal('agent', { description: 'Agent mode: creates a parent-owned adaptive research job and returns a job pointer for agent_poll. Single-query only; no cursor/source/knowledge/research category.' }),
      // Depth mirrors runtime validation (web-contract): 'balanced' default
      // when absent; any other value rejects. Schema cannot drift from it.
      depth: Type.Optional(StringEnum(['balanced', 'deep'], { description: 'Agent-job gather depth (default balanced; deep widens the gather profile).' })),
    }, { additionalProperties: false, description: 'Adaptive agent research job (single query, no cursor/source/knowledge/research).' }),
  ], { description: 'Single {query} | batch {queries[1..8]} | agent {query, mode:"agent"}. Exactly one of query (single/agent) or queries (batch, 1..8).' });
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
 * Strict graph parameters: query/probe/schema branches per language, with
 * schema views split by selector shape. SPARQL query carries no
 * pageSize/cursor (v1 returns one bounded response without cursor).
 * Optional languages filter advertises only configured branches (dql iff
 * DIFFBOT_TOKEN present, sparql iff GRAPH_SPARQL_ENDPOINT configured).
 * Defaults to both, preserving existing callers. Runtime per-language
 * fail-closed stays as backstop for unconfigured dispatch.
 */
export function buildGraphParameters(languages: readonly GraphLanguage[] = [...GRAPH_LANGUAGES]): TSchema {
  const enabled = new Set<GraphLanguage>(languages);
  const queryText = (description: string): TSchema =>
    Type.String({ minLength: 1, maxLength: MAX_GRAPH_QUERY_CHARS, description });
  const branches: TSchema[] = [];
  if (enabled.has('dql')) {
    branches.push(Type.Object({
      action: Type.Literal('query'), language: Type.Literal('dql'),
      query: queryText('DQL query text.'),
      pageSize: Type.Optional(Type.Integer({ minimum: GRAPH_PAGE_SIZE_MIN, maximum: GRAPH_PAGE_SIZE_MAX, description: 'Transport page size (default 10, max 100); never rewrites query text.' })),
      cursor: Type.Optional(Type.String({ maxLength: MAX_GRAPH_CURSOR_LENGTH, description: 'Opaque base64url cursor bound to query/pageSize.' })),
    }, { additionalProperties: false }));
  }
  if (enabled.has('sparql')) {
    branches.push(Type.Object({
      action: Type.Literal('query'), language: Type.Literal('sparql'),
      query: queryText('SPARQL SELECT/ASK text; SERVICE, dataset (FROM), and update forms reject before dispatch.'),
    }, { additionalProperties: false }));
  }
  for (const language of GRAPH_LANGUAGES) {
    if (!enabled.has(language)) continue;
    const lang = Type.Literal(language);
    branches.push(Type.Object({
      action: Type.Literal('probe'), language: lang,
      queries: Type.Array(queryText('Countable entity query.'), { minItems: 1, maxItems: MAX_GRAPH_BATCH }),
    }, { additionalProperties: false }));
    branches.push(Type.Object({ action: Type.Literal('schema'), language: lang, view: Type.Literal('types'), includeDeprecated: Type.Optional(Type.Boolean()) }, { additionalProperties: false }));
    branches.push(Type.Object({ action: Type.Literal('schema'), language: lang, view: Type.Literal('fields'), name: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_GRAPH_NAME_CHARS })), includeDeprecated: Type.Optional(Type.Boolean()) }, { additionalProperties: false }));
    branches.push(Type.Object({ action: Type.Literal('schema'), language: lang, view: Type.Literal('search'), query: queryText('Ontology search text.'), includeDeprecated: Type.Optional(Type.Boolean()) }, { additionalProperties: false }));
    branches.push(Type.Object({ action: Type.Literal('schema'), language: lang, view: Type.Literal('describe'), name: Type.String({ minLength: 1, maxLength: MAX_GRAPH_NAME_CHARS }), includeDeprecated: Type.Optional(Type.Boolean()) }, { additionalProperties: false }));
  }
  return Type.Union(branches, { description: 'Graph query/probe/schema by language; SPARQL query rejects pageSize/cursor.' });
}

import {
  DESKTOP_ACTIONS,
  DESKTOP_ACTION_CONTRACT,
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
 * Strict desktop parameters: one branch per contract-table action. Required
 * and allowed fields generate directly from DESKTOP_ACTION_CONTRACT so the
 * schema cannot drift from the documented action-to-fields contract.
 */
export function buildDesktopParameters(): TSchema {
  const branches = DESKTOP_ACTIONS.map((action) => {
    const spec = DESKTOP_ACTION_CONTRACT[action];
    const properties: Record<string, TSchema> = { action: Type.Literal(action) };
    for (const field of spec.allowed) properties[field] = Type.Optional(DESKTOP_FIELDS[field]);
    for (const field of spec.required) properties[field] = DESKTOP_FIELDS[field];
    return Type.Object(properties, { additionalProperties: false, description: `${action} desktop action.` });
  });
  return Type.Union(branches, { description: 'Closed desktop action with action-specific targets and payloads.' });
}

import {
  auxSpecFor,
  canonicalActionsFor,
  MAX_SELECTOR_LENGTH as MAX_SOCIAL_SELECTOR_LENGTH,
  selectorSpecFor,
  SOCIAL_DATE_RE,
  SOCIAL_MAX_LIMIT,
  SOCIAL_PLATFORMS,
  type SocialAction,
  type SocialAuxSpec,
  type SocialPlatform,
  type SocialSelectorField,
} from './social/social-contract.js';

// Selector length bound canonical in social-contract.ts (single source of truth).
const MAX_SOCIAL_CURSOR_LENGTH = 4096;
const SELECTOR_DESCRIPTIONS: Record<SocialSelectorField, string> = {
  query: 'Platform search query.',
  postId: 'Post or note id.',
  commentId: 'Comment id.',
  user: 'User handle.',
  community: 'Community selector.',
  topic: 'Topic id.',
};

function socialSelectorField(field: SocialSelectorField): TSchema {
  return Type.String({ minLength: 1, maxLength: MAX_SOCIAL_SELECTOR_LENGTH, description: SELECTOR_DESCRIPTIONS[field] });
}

// Aux fields mirror the per-action contract registry: only honored fields are
// advertised, with closed enums where the registry pins vocabulary. Anything
// else rejects at schema validation instead of dropping silently at runtime.
function socialAuxFields(aux: SocialAuxSpec): Record<string, TSchema> {
  const fields: Record<string, TSchema> = {};
  if (aux.sort !== undefined) fields.sort = Type.Optional(StringEnum([...aux.sort], { description: 'Result ordering; unsupported values reject.' }));
  if (aux.timeRange !== undefined) {
    fields.timeRange = aux.timeRange === 'date'
      ? Type.Optional(Type.String({ pattern: SOCIAL_DATE_RE.source, description: 'Earliest date as YYYY-MM-DD.' }))
      : Type.Optional(Type.String({ minLength: 1, description: 'Upstream time filter passed verbatim.' }));
  }
  if (aux.feedVariant !== undefined) fields.feedVariant = Type.Optional(StringEnum([...aux.feedVariant], { description: 'Feed or notification variant.' }));
  if (aux.includeReplies !== undefined) fields.includeReplies = Type.Optional(Type.Boolean({ description: 'Include nested replies; false keeps top-level items only.' }));
  return fields;
}

function socialBody(
  platform: SocialPlatform,
  action: SocialAction,
  allowed: readonly SocialSelectorField[],
  requiredFields: ReadonlySet<string>,
  maxLimit: number,
): TSchema {
  const properties: Record<string, TSchema> = {
    platform: Type.Literal(platform),
    action: Type.Literal(action),
    url: requiredFields.has('url')
      ? Type.String({ minLength: 1, description: 'Canonical platform URL (selectors derived from closed path shapes).' })
      : Type.Optional(Type.String({ minLength: 1, description: 'Canonical platform URL (selectors derived from closed path shapes).' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLimit, description: `Max items 1..${maxLimit}. Out-of-range values reject.` })),
    cursor: Type.Optional(Type.String({ maxLength: MAX_SOCIAL_CURSOR_LENGTH, description: 'Opaque pagination cursor.' })),
    ...socialAuxFields(auxSpecFor(platform, action)),
  };
  for (const field of allowed) {
    properties[field] = requiredFields.has(field)
      ? socialSelectorField(field)
      : Type.Optional(socialSelectorField(field));
  }
  return Type.Object(properties, { additionalProperties: false, description: `${platform} ${action} request.` });
}

/**
 * Strict social parameters: one branch per advertised platform/action from
 * selectorSpecFor. anyOf selectors expand into explicit alternatives
 * (each selector directly, or a canonical URL deriving it), mirroring the
 * nested-union pattern in src/github/github.ts.
 */
export function buildSocialParameters(): TSchema {
  const branches: TSchema[] = [];
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of canonicalActionsFor(platform)) {
      const spec = selectorSpecFor(platform, action);
      const allowed = [...(spec.required ?? []), ...(spec.anyOf ?? [])].filter(
        (field, index, all) => all.indexOf(field) === index,
      );
      const required = new Set<string>(spec.required ?? []);
      const maxLimit = spec.maxLimit ?? SOCIAL_MAX_LIMIT;
      if (spec.anyOf !== undefined && spec.anyOf.length > 0) {
        for (const field of spec.anyOf) {
          branches.push(socialBody(platform, action, allowed, new Set([...required, field]), maxLimit));
        }
        branches.push(socialBody(platform, action, allowed, new Set([...required, 'url']), maxLimit));
      } else {
        branches.push(socialBody(platform, action, allowed, required, maxLimit));
        // URL-only alternative when the canonical URL extractor can supply
        // every required selector (it derives postId/commentId/user/community/
        // topic, never query). Runtime fills missing selectors from the URL
        // and rejects unrecognized shapes with invalid_request.
        if (required.size > 0 && [...required].every((field) => field !== 'query' && field !== 'url')) {
          branches.push(socialBody(platform, action, allowed, new Set(['url']), maxLimit));
        }
      }
    }
  }
  return Type.Union(branches, { description: 'Platform-specific social request.' });
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
 * Strict browser parameters: one branch per action with bounds mirroring
 * browser-policy constants; semanticAction nests the closed
 * locator/verb union above.
 */
export function buildBrowserParameters(): TSchema {
  const selector = (description: string): TSchema =>
    Type.String({ minLength: 1, maxLength: MAX_SELECTOR_LENGTH, description });
  const text = Type.String({ minLength: 1, maxLength: MAX_BROWSER_TEXT_LENGTH });
  const compact = Type.Optional(Type.Boolean());
  const coord = Type.Optional(Type.Number({ minimum: -MAX_SCROLL_COORD, maximum: MAX_SCROLL_COORD }));
  const branches: TSchema[] = [
    Type.Object({ op: Type.Literal('observe'), what: StringEnum(['status', 'tabs', 'get_url', 'get_title', 'text', 'html', 'snapshot', 'screenshot']), selector: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_LENGTH })), compact }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('navigate'), url: Type.String({ minLength: 1, maxLength: MAX_BROWSER_URL_LENGTH }) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('evaluate'), expression: Type.String({ minLength: 1, maxLength: MAX_EXPRESSION_LENGTH }) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('click'), selector: selector('CSS/XPath selector to click.') }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('type'), selector: selector('Target selector.'), text }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('scroll'), selector: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_LENGTH })), x: coord, y: coord }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('close') }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('cookies'), urls: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('set_cookies'), cookies: Type.Array(Type.Any(), { maxItems: MAX_COOKIES }), urls: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('snapshot'), compact }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('fill'), selector: selector('Target selector.'), text }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('select'), selector: selector('Target selector.'), values: Type.Array(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH }), { minItems: 1, maxItems: MAX_SELECT_VALUES }) }, { additionalProperties: false }),
    Type.Object({
      action: Type.Literal('wait'),
      selector: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_LENGTH })),
      text: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })),
      waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })),
    }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('semanticAction'), semanticAction: Type.Union(semanticActionBranches()) }, { additionalProperties: false }),
    Type.Object({
      action: Type.Literal('job'),
      job: Type.Object({
        steps: Type.Array(Type.Union([
          Type.Object({
            kind: Type.Literal('open'),
            url: Type.String({ minLength: 1, maxLength: MAX_BROWSER_URL_LENGTH }),
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('click'),
            selector: selector('CSS/XPath selector to click.'),
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('fill'),
            selector: selector('Target selector.'),
            text,
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('type'),
            selector: selector('Target selector.'),
            text,
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('select'),
            selector: selector('Target selector.'),
            values: Type.Array(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH }), { minItems: 1, maxItems: MAX_SELECT_VALUES }),
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('wait'),
            selector: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_LENGTH })),
            text: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })),
            waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })),
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('assert'),
            selector: selector('Target selector to assert.'),
            assertText: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })),
            waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })),
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('snapshot'),
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal('screenshot'),
            continueOnFailure: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }),
        ]), { minItems: 1, maxItems: MAX_JOB_STEPS }),
        maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_JOB_STEPS })),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
    Type.Object({
      action: Type.Literal('batch'),
      batch: Type.Object({
        commands: Type.Array(Type.Object({
          args: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          sensitive: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_BATCH_COMMANDS }),
        maxCommands: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BATCH_COMMANDS })),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  ];
  return Type.Union(branches, { description: 'Browser action with bounded fields and strict semanticAction vocabulary.' });
}

// ── kg parameters: discriminated action union from knowledge-contract vocabulary ──
// Mirrors validateKgSearch/validateKgEnhance/validateKgNlp bounds so the
// model-facing schema cannot drift from runtime validation. Search pins
// language 'dql' with integer limit 1..50; enhance splits Person/Organization
// into per-selector required branches (Person-only employer/title/school never
// advertised on Organization); analyze_text bounds text 1..KG_NLP_MAX_CHARS with
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

function kgEnhanceBranch(
  type: 'Person' | 'Organization',
  requiredSelector: string,
  allowed: readonly string[],
): TSchema {
  const selectorField = (field: string): TSchema =>
    Type.String({ minLength: 1, description: `Enhance selector: ${field}.` });
  const properties: Record<string, TSchema> = {
    action: Type.Literal('enhance'),
    type: Type.Literal(type),
    ...kgEnhanceModifiers(),
  };
  for (const field of allowed) {
    properties[field] = field === requiredSelector ? selectorField(field) : Type.Optional(selectorField(field));
  }
  return Type.Object(properties, { additionalProperties: false, description: `kg enhance ${type} request (selector ${requiredSelector} required).` });
}

export function buildKgParameters(): TSchema {
  const searchBranch = Type.Object({
    action: Type.Literal('search'),
    query: Type.String({ minLength: 1, description: 'Entity-returning DQL query text.' }),
    language: Type.Literal('dql', { description: "Query language; 'dql' fixed in v1." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Result limit 1..50.' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_KG_CURSOR_LENGTH, description: 'Opaque base64url cursor.' })),
    ...kgSharedSelectorFields(),
  }, { additionalProperties: false, description: 'kg search request.' });
  const enhanceBranches: TSchema[] = [
    ...KG_PERSON_SELECTORS.map((selector) => kgEnhanceBranch('Person', selector, KG_PERSON_SELECTORS)),
    ...ENHANCE_SELECTOR_KEYS.map((selector) => kgEnhanceBranch('Organization', selector, ENHANCE_SELECTOR_KEYS)),
  ];
  const analyzeBranch = Type.Object({
    action: Type.Literal('analyze_text'),
    text: Type.String({ minLength: 1, maxLength: KG_NLP_MAX_CHARS, description: `Source text 1..${KG_NLP_MAX_CHARS} chars (sent with consent).` }),
    language: Type.Optional(Type.Union(
      [Type.Literal('auto'), Type.String({ pattern: '^[a-z]{2}$', minLength: 2, maxLength: 2 })],
      { description: 'ISO 639-1 code or auto.' },
    )),
    extractEntities: Type.Optional(Type.Boolean()),
    extractFacts: Type.Optional(Type.Boolean()),
    extractSentiment: Type.Optional(Type.Boolean()),
    extractTopics: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false, description: 'kg analyze_text request.' });
  return Type.Union([searchBranch, ...enhanceBranches, analyzeBranch], { description: 'One canonical kg action request.' });
}

// ── fetch parameters: 5-branch union mirroring web-fetch-route.ts ──
// Read modes live on the url/urls branches only: mode defaults to readable
// when absent; prompt is required iff mode is answer; per-call answerModel
// is removed (schema rejects it via additionalProperties:false); raw forbids
// query/topK/prompt; answer forbids query/topK (prompt is the question). Runtime re-validates every
// request; sitemap/retrieve/claim-check branches carry no mode fields.

function fetchReadableFields(): Record<string, TSchema> {
  return {
    query: Type.Optional(Type.String({ minLength: 1, description: 'Rank extract via the read-query path.' })),
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Top chunks, max 20.' })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: 'Readable-mode output cap, max 50000.' })),
  };
}

function fetchReadFamily(
  locator: Record<string, TSchema>,
  description: string,
): TSchema {
  const answerPrompt = Type.String({
    minLength: 1,
    maxLength: FETCH_ANSWER_PROMPT_MAX_CHARS,
    description: 'Answer-mode question. Required exactly when mode is answer.',
  });
  return Type.Union([
    Type.Object(
      { ...locator, ...fetchReadableFields() },
      { additionalProperties: false, description: `${description} Readable mode (implicit default).` },
    ),
    Type.Object(
      { ...locator, mode: Type.Literal('readable'), ...fetchReadableFields() },
      { additionalProperties: false, description: `${description} Readable mode (explicit).` },
    ),
    Type.Object(
      { ...locator, mode: Type.Literal('raw') },
      { additionalProperties: false, description: `${description} Raw exact-HTTP text mode.` },
    ),
    Type.Object(
      { ...locator, mode: Type.Literal('answer'), prompt: answerPrompt },
      { additionalProperties: false, description: `${description} Quick-investigate answer mode.` },
    ),
  ], { description });
}

export function buildFetchParameters(): TSchema {
  const liveUrl = (description: string): TSchema => Type.String({
    minLength: 1,
    pattern: '^[Hh][Tt][Tt][Pp][Ss]?://',
    description,
  });
  const queryField = Type.Optional(Type.String({ minLength: 1, description: 'Rank sitemap URLs.' }));
  return Type.Union([
    fetchReadFamily(
      { url: liveUrl('Single HTTP(S)/GitHub asset URL. Filesystem paths are not model-addressable.') },
      'Single-URL fetch.',
    ),
    fetchReadFamily(
      { urls: Type.Array(liveUrl('HTTP(S)/GitHub asset URL.'), { minItems: 1, maxItems: 8, description: 'Per-URL reads 1..8 in input order with per-URL isolation.' }) },
      'Multi-URL fetch.',
    ),
    Type.Object({
      url: liveUrl('HTTP(S) sitemap root URL.'), siteMap: Type.Literal(true, { description: 'Discovered same-origin URLs.' }),
      query: queryField,
      maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: 'Max sitemap pages, max 25 (sitemap only).' })),
    }, { additionalProperties: false, description: 'Sitemap discovery (no read modes).' }),
    Type.Object({
      responseId: Type.String({ minLength: 1, description: 'Cached corpus id (no network).' }),
      sourceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000 })),
      findText: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false, description: 'Cached corpus slice (no network, no read modes).' }),
    Type.Object({
      responseId: Type.String({ minLength: 1 }),
      claims: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20, description: 'Cached claim verification 1..20 (no network).' }),
      sourceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
    }, { additionalProperties: false, description: 'Cached claim verification (no network, no read modes).' }),
  ], { description: 'Single {url} | batch {urls[1..8]} | sitemap {url, siteMap:true} | retrieve {responseId} | claim-check {responseId, claims[1..20]}. Read modes (readable|raw|answer) live on the url/urls branches only.' });
}
