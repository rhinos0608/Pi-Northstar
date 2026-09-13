// Strict public tool parameter schemas (no runtime behavior change).
// Each builder mirrors its internal contract vocabulary and bounds so the
// model-facing schema cannot drift from runtime validation. Registration
// wiring stays in src/index.ts until the integration task adopts these.
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { researchSourceIds } from './capabilities.js';
import {
  MAX_WEB_QUERY_LENGTH,
  RESEARCH_SEARCH_LIMIT_MAX,
  SEARCH_CATEGORY_NAMES,
  WEB_SEARCH_LIMIT_MAX,
  WEB_SEARCH_MAX_BATCH_QUERIES,
  WEB_SEARCH_MAX_DOMAINS,
} from './web/web-contract.js';
import { WEB_PROVIDER_MIN_YEAR_FROM } from './web/web-search-types.js';

// Category names canonical in web-contract.ts (single source of truth).

function webFilterFields(options?: { agent?: boolean; limitMax?: number; researchOnly?: boolean }): Record<string, TSchema> {
  const fields: Record<string, TSchema> = {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: options?.limitMax ?? RESEARCH_SEARCH_LIMIT_MAX, description: 'Max results: plain default 8 max 20; research default 12 max 30. Out-of-range rejected, never clamped.' })),
    yearFrom: Type.Optional(Type.Integer({ minimum: WEB_PROVIDER_MIN_YEAR_FROM, maximum: new Date().getUTCFullYear(), description: 'Earliest year in [1900, current UTC year].' })),
    includeContent: Type.Optional(Type.Boolean({ description: 'Reuse full content when providers return it (cost-gated); default false. Search-only.' })),
    recency: Type.Optional(StringEnum(['day', 'week', 'month', 'year'], { description: 'Recency filter; intersects with yearFrom (later bound wins). Search-only.' })),
    domains: Type.Optional(Type.Array(Type.String(), { maxItems: WEB_SEARCH_MAX_DOMAINS, description: "Domain allow/exclude list, '-host' excludes. Search-only." })),
  };
  if (options?.agent !== true) {
    fields.category = options?.researchOnly === true
      ? Type.Literal('research', { description: 'Research category pin for the research limit cap (30).' })
      : Type.Optional(StringEnum(SEARCH_CATEGORY_NAMES, { description: 'Result set: plain web discovery, or "research" for the 12 academic/public-data sources. mode "agent" rejects category "research".' }));
    fields.source = Type.Optional(StringEnum(['all', ...researchSourceIds()], { description: 'Research-only source pin (default all). Cursor needs one exact source, not all.' }));
    fields.knowledge = Type.Optional(Type.Object({
      entities: Type.Optional(Type.Boolean()),
      facts: Type.Optional(Type.Boolean()),
      topics: Type.Optional(Type.Boolean()),
      sentiment: Type.Optional(Type.Boolean()),
      enhance: Type.Optional(Type.Boolean()),
    }, { minProperties: 1, additionalProperties: false, description: 'Optional knowledge composition over top results. Requires PI_SEARCH_KG_ENRICHMENT=1 plus at least one true flag (all-false stays runtime-rejected). Not supported with category "research".' }));
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
  return Type.Union([
    Type.Object({ query: queryField, ...webFilterFields({ limitMax: WEB_SEARCH_LIMIT_MAX }) }, { additionalProperties: false, description: 'Single-query web search.' }),
    Type.Object({ query: queryField, ...webFilterFields({ limitMax: RESEARCH_SEARCH_LIMIT_MAX, researchOnly: true }) }, { additionalProperties: false, description: 'Single-query research search (category research, limit max 30).' }),
    Type.Object({
      queries: batchField,
      ...webFilterFields({ limitMax: WEB_SEARCH_LIMIT_MAX }),
    }, { additionalProperties: false, description: 'Batch web search (1..8 queries).' }),
    Type.Object({
      queries: batchField,
      ...webFilterFields({ limitMax: RESEARCH_SEARCH_LIMIT_MAX, researchOnly: true }),
    }, { additionalProperties: false, description: 'Batch research search (category research, limit max 30).' }),
    Type.Object({
      query: queryField,
      mode: Type.Literal('agent', { description: 'Agent mode: returns a provider-generated research report as the tool text (untrusted evidence). Single-query only; no cursor/source/knowledge/research category.' }),
      ...webFilterFields({ agent: true, limitMax: WEB_SEARCH_LIMIT_MAX }),
    }, { additionalProperties: false, description: 'Agent research report (single query, no cursor/source/knowledge/research).' }),
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
} from './graph/graph-contract.js';

/**
 * Strict graph parameters: query/probe/schema branches per language, with
 * schema views split by selector shape. SPARQL query carries no
 * pageSize/cursor (v1 returns one bounded response without cursor).
 */
export function buildGraphParameters(): TSchema {
  const queryText = (description: string): TSchema =>
    Type.String({ minLength: 1, maxLength: MAX_GRAPH_QUERY_CHARS, description });
  const branches: TSchema[] = [
    Type.Object({
      action: Type.Literal('query'), language: Type.Literal('dql'),
      query: queryText('DQL query text.'),
      pageSize: Type.Optional(Type.Integer({ minimum: GRAPH_PAGE_SIZE_MIN, maximum: GRAPH_PAGE_SIZE_MAX, description: 'Transport page size (default 10, max 100); never rewrites query text.' })),
      cursor: Type.Optional(Type.String({ maxLength: MAX_GRAPH_CURSOR_LENGTH, description: 'Opaque base64url cursor bound to query/pageSize.' })),
    }, { additionalProperties: false }),
    Type.Object({
      action: Type.Literal('query'), language: Type.Literal('sparql'),
      query: queryText('SPARQL SELECT/ASK text; SERVICE and update forms reject before dispatch.'),
    }, { additionalProperties: false }),
  ];
  for (const language of GRAPH_LANGUAGES) {
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
  canonicalActionsFor,
  MAX_SELECTOR_LENGTH as MAX_SOCIAL_SELECTOR_LENGTH,
  selectorSpecFor,
  SOCIAL_MAX_LIMIT,
  SOCIAL_PLATFORMS,
  type SocialAction,
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

function socialBody(
  platform: SocialPlatform,
  action: SocialAction,
  allowed: readonly SocialSelectorField[],
  requiredFields: ReadonlySet<string>,
): TSchema {
  const properties: Record<string, TSchema> = {
    platform: Type.Literal(platform),
    action: Type.Literal(action),
    url: requiredFields.has('url')
      ? Type.String({ minLength: 1, description: 'Canonical platform URL (selectors derived from closed path shapes).' })
      : Type.Optional(Type.String({ minLength: 1, description: 'Canonical platform URL (selectors derived from closed path shapes).' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SOCIAL_MAX_LIMIT, description: 'Max items. Over-cap clamps with warning at runtime.' })),
    cursor: Type.Optional(Type.String({ maxLength: MAX_SOCIAL_CURSOR_LENGTH, description: 'Opaque pagination cursor.' })),
    feedVariant: Type.Optional(Type.String()),
    sort: Type.Optional(Type.String()),
    timeRange: Type.Optional(Type.String()),
    includeReplies: Type.Optional(Type.Boolean()),
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
      if (spec.anyOf !== undefined && spec.anyOf.length > 0) {
        for (const field of spec.anyOf) {
          branches.push(socialBody(platform, action, allowed, new Set([...required, field])));
        }
        branches.push(socialBody(platform, action, allowed, new Set([...required, 'url'])));
      } else {
        branches.push(socialBody(platform, action, allowed, required));
        // URL-only alternative when the canonical URL extractor can supply
        // every required selector (it derives postId/commentId/user/community/
        // topic, never query). Runtime fills missing selectors from the URL
        // and rejects unrecognized shapes with invalid_request.
        if (required.size > 0 && [...required].every((field) => field !== 'query' && field !== 'url')) {
          branches.push(socialBody(platform, action, allowed, new Set(['url'])));
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
  SEMANTIC_LOCATORS,
  SEMANTIC_VERBS,
} from './browser/browser-policy.js';

const MAX_BATCH_COMMANDS = 20;
const MAX_JOB_STEPS = 20;

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
        steps: Type.Array(Type.Object({
          kind: Type.Optional(Type.String()),
          url: Type.Optional(Type.String({ maxLength: MAX_BROWSER_URL_LENGTH })),
          selector: Type.Optional(Type.String({ maxLength: MAX_SELECTOR_LENGTH })),
          text: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })),
          values: Type.Optional(Type.Array(Type.String())),
          waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })),
          assertText: Type.Optional(Type.String({ maxLength: MAX_BROWSER_TEXT_LENGTH })),
          continueOnFailure: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_JOB_STEPS }),
        maxSteps: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_JOB_STEPS })),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
    Type.Object({
      action: Type.Literal('batch'),
      batch: Type.Object({
        commands: Type.Array(Type.Object({
          args: Type.Array(Type.String(), { minItems: 1 }),
          sensitive: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_BATCH_COMMANDS }),
        maxCommands: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BATCH_COMMANDS })),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  ];
  return Type.Union(branches, { description: 'Browser action with bounded fields and strict semanticAction vocabulary.' });
}
