// Deterministic gather executor (Task 7): compiles GatherIntents against the
// frozen capability snapshot and executes them via an injectable tool seam.
// Ordered dispatch, Promise.allSettled parallel legs, ledger-order merge —
// mirroring runAdaptiveCore merge mechanics. Per-action failures stay
// per-action: one failed lane never kills the round; warnings surface.
//
// Task 8 BudgetEnvelope: the global maxGatherActions envelope, per-lane caps,
// and the round-scoped fetch reserve from agent-policy.ts govern every round.
// Width N = N actions total per round across ALL lanes (the core slices to
// the profile width before calling; the executor enforces envelope + lanes).

import { normalizeUrl } from '../../search/fusion.js';
import {
  adaptGithubResult,
  adaptKgResult,
  adaptResearchResult,
  isAdaptedGatherPayload,
} from './agent-gather-adapters.js';
import {
  admitFromFetch,
  admitGithubContent,
  admitKgFields,
  admitResearchAbstract,
  admitSocialBody,
  admitVideoTranscriptSegment,
  collectCandidates,
  type AgentCandidate,
} from './agent-acquisition.js';
import {
  gatherActionAdmissibility,
  type EffectiveCapabilitiesSnapshot,
} from './agent-capabilities.js';
import { AGENT_MAX_FETCH_ROUNDS, AGENT_WARNING_MAX_BYTES } from './agent-contract.js';
import { sanitizeEvaluatorQuery } from './agent-evaluator.js';
import {
  actionSearchText,
  compileIntentArgs,
  intentRoute,
  intentToGatherActionLike,
  validateGatherIntent,
  type GatherIntent,
} from './agent-gather-intents.js';
import {
  admissibleGatherLanes,
  AGENT_DEFAULT_BUDGETS,
  canDispatchAnyAction,
  DEFAULT_LANE_CAPS,
  DEFAULT_ROUND_FETCH_CAPS,
  type GatherLane,
} from './agent-policy.js';
import { truncateUtf8Bytes } from './agent-report-route.js';
import type { AgentEvidence, AgentState } from './agent-state.js';

/** Injectable tool seam: web legs use the core search/fetch legs; specialist
 *  routes use native surfaces. Absent specialist fns degrade to web + warning. */
export interface GatherTools {
  search(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>>;
  fetchText(url: string): Promise<string>;
  research?: (args: Record<string, unknown>) => Promise<unknown>;
  github?: (args: Record<string, unknown>) => Promise<unknown>;
  social?: (args: Record<string, unknown>) => Promise<unknown>;
  video?: (args: Record<string, unknown>) => Promise<unknown>;
  kg?: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface GatherCounters {
  /** Web-search ATTEMPTS (success or failure): every dispatched web_search
   *  costs the search budget, matching the legacy core paths which increment
   *  per dispatched search. Failed searches cost the search budget only (the
   *  envelope spend was already recorded at dispatch time). */
  searchesUsed: number;
  fetchesUsed: number;
  /** Executor gather actions consumed at round start (envelope spend). */
  gatherActionsUsed?: number;
  /** Per-lane executor spend at round start (absent lanes = 0). */
  laneActionsUsed?: Partial<Record<GatherLane, number>>;
}

export interface GatherExecutorContext {
  /** Frozen per-job snapshot; absent = compat (non-web degrades to web). */
  snapshot?: EffectiveCapabilitiesSnapshot;
  /** Owning ledger: query records + admission write here during merge. */
  state: AgentState;
  /** Search/fetch spend at round start (Task 8 envelope replaces this). */
  counters: GatherCounters;
  budgets?: {
    maxSearches: number;
    maxFetches: number;
    maxGatherActions?: number;
    laneCaps?: Partial<Record<GatherLane, number>>;
    roundFetchCaps?: readonly [number, number, number];
  };
  /** Per-intent question linkage (parallel to intents); absent entries fall
   *  back to token-overlap matching like the legacy web path. */
  questionIds?: Array<string | undefined>;
  tools: GatherTools;
}

export interface GatherPerAction {
  route: string;
  degraded: boolean;
  skipped?: string;
}

export interface GatherOutcome {
  admitted: AgentEvidence[];
  candidates: AgentCandidate[];
  warnings: string[];
  /** Deltas consumed by this call (core adds to its counters). */
  searchesUsed: number;
  fetchesUsed: number;
  queriesSearched: string[];
  queryRejected: number;
  /** Fetched web bodies for passage composition (legacy compose path). */
  webContent: Array<{ url: string; title: string; body: string }>;
  perAction: GatherPerAction[];
}

export type GatherExecutorFn = (
  intents: GatherIntent[],
  round: number,
  ctx: GatherExecutorContext,
) => Promise<GatherOutcome>;

const cappedWarning = (text: string): string => truncateUtf8Bytes(text, AGENT_WARNING_MAX_BYTES);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** First array found under any alias key (defensive native-surface parse). */
function pickArray(payload: unknown, keys: string[]): Array<Record<string, unknown>> {
  const record = asRecord(payload);
  const pools: unknown[] = record === undefined ? [payload] : [...keys.map((key) => record[key]), payload];
  for (const pool of pools) {
    if (Array.isArray(pool)) {
      return pool.filter((entry): entry is Record<string, unknown> => asRecord(entry) !== undefined);
    }
  }
  return [];
}

function httpUrl(entry: Record<string, unknown>): string | undefined {
  for (const key of ['canonicalUrl', 'url']) {
    const value = asNonEmptyString(entry[key]);
    if (value !== undefined && /^https?:\/\//i.test(value)) return value;
  }
  return undefined;
}

/** Row publication year: integer `year` key, else a leading YYYY from a
 *  `published`/`publishedAt`/`date`/`publicationDate` string. Undefined when
 *  the row carries no parseable year (unfilterable rows always admit). */
function researchRowYear(row: Record<string, unknown>): number | undefined {
  const direct = row['year'];
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct;
  for (const key of ['published', 'publishedAt', 'date', 'publicationDate']) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const match = /^(\d{4})/.exec(value.trim());
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

/** Client-side [yearFrom, yearTo] gate for the research admission branch:
 *  rows outside the intent range stay candidates-only (never evidence).
 *  Bounds absent on the intent, or no parseable row year, admit. */
function researchYearInRange(row: Record<string, unknown>, intent: GatherIntent): boolean {
  if (intent.kind !== 'research_search') return true;
  if (intent.yearFrom === undefined && intent.yearTo === undefined) return true;
  const year = researchRowYear(row);
  if (year === undefined) return true;
  if (intent.yearFrom !== undefined && year < intent.yearFrom) return false;
  if (intent.yearTo !== undefined && year > intent.yearTo) return false;
  return true;
}

interface PlannedAction {
  order: number;
  intent: GatherIntent;
  route: string;
  query: string;
  questionId?: string;
  degraded: boolean;
  skipReason?: string;
  args: Record<string, unknown>;
}

function planActions(intents: GatherIntent[], ctx: GatherExecutorContext): { planned: PlannedAction[]; warnings: string[] } {
  const warnings: string[] = [];
  const planned: PlannedAction[] = [];
  intents.forEach((raw, order) => {
    const validated = validateGatherIntent(raw);
    if (!validated.ok) {
      warnings.push(cappedWarning(`gather action ${order} invalid (${validated.reason}); skipped`));
      planned.push({
        order,
        intent: raw,
        route: 'web',
        query: '',
        degraded: false,
        skipReason: validated.reason,
        args: {},
      });
      return;
    }
    const intent = validated.value;
    const route = intentRoute(intent);
    let degraded = false;
    if (route !== 'web') {
      if (ctx.snapshot === undefined) {
        degraded = true;
        warnings.push(cappedWarning(`route degraded: ${route} unavailable (no capabilities snapshot)`));
      } else {
        const admissibility = gatherActionAdmissibility(intentToGatherActionLike(intent), ctx.snapshot);
        if (!admissibility.allowed) {
          degraded = true;
          warnings.push(cappedWarning(`route degraded: ${route} unavailable (${admissibility.reason ?? 'unavailable'})`));
        } else if (admissibility.reason !== undefined) {
          warnings.push(cappedWarning(admissibility.reason));
        }
      }
      // Tool-absent specialist routes degrade the same way: no native surface
      // exists yet for social/video, so they ride web_search + warning.
      if (!degraded) {
        const tool = specialistTool(route, ctx.tools);
        if (tool === undefined) {
          degraded = true;
          warnings.push(cappedWarning(`route degraded: ${route} unavailable (no tool surface)`));
        }
      }
    }
    // web_fetch reads via the frozen snapshot's fetch capability: reject before
    // dispatch when fetch is unavailable, without rewriting the URL into a search.
    if (intent.kind === 'web_fetch' && ctx.snapshot !== undefined) {
      const fetchAdmissibility = gatherActionAdmissibility({ kind: 'fetch' }, ctx.snapshot);
      if (!fetchAdmissibility.allowed) {
        warnings.push(cappedWarning(`gather action ${order} fetch unavailable (${fetchAdmissibility.reason ?? 'unavailable'}); skipped`));
        planned.push({ order, intent, route, query: intent.url, degraded: false, skipReason: fetchAdmissibility.reason ?? 'fetch unavailable', args: {} });
        return;
      }
    }
    // web_fetch carries a verbatim candidate URL, not a search string: record
    // it unsanitized (sanitizeEvaluatorQuery folds/collapses text and must
    // never rewrite a URL). Validation already bounded it.
    const query = intent.kind === 'web_fetch' ? intent.url : sanitizeEvaluatorQuery(actionSearchText(intent));
    if (query === '') {
      warnings.push(cappedWarning(`gather action ${order} empty after sanitize; skipped`));
      planned.push({ order, intent, route, query, degraded, skipReason: 'empty_query', args: {} });
      return;
    }
    planned.push({
      order,
      intent,
      route,
      query,
      ...(ctx.questionIds?.[order] === undefined ? {} : { questionId: ctx.questionIds[order] as string }),
      degraded,
      args: compileIntentArgs(intent),
    });
  });
  return { planned, warnings };
}

/** A planned leg consumes a maxSearches slot only when it dispatches a real
 *  search: native web_search or a degraded specialist riding web. web_fetch
 *  reads a URL directly (fetch reserve only) and specialist-native legs never
 *  touch searchesUsed. */
function consumesSearchSlot(action: PlannedAction): boolean {
  if (action.intent.kind === 'web_fetch') return false;
  return action.degraded ? true : action.route === 'web';
}

/** Fetch-leg kind for round-reserve allocation: 'single' (web_fetch: exactly
 *  one fixed fetch attempt), 'search' (web_search legs splitting the remainder
 *  floor+remainder in ledger order), 'none' (specialist-native legs: zero
 *  web-fetch reserve). */
export type FetchLegKind = 'none' | 'single' | 'search';

/** Deterministic round fetch-reserve split: web_fetch singles deduct first
 *  (exactly 1 each, capped at the remaining reserve in ledger order — later
 *  singles past the cap get 0), web_search legs split the remainder
 *  floor+remainder in ledger order, specialist-native legs get zero.
 *  Pure (exported for tests). */
export function allocateFetchBudgets(legs: FetchLegKind[], fetchRemaining: number): number[] {
  const searchOrder = legs.map((leg, order) => (leg === 'search' ? order : -1)).filter((order) => order >= 0);
  const budgets = legs.map(() => 0);
  let singlesRemaining = Math.max(0, fetchRemaining);
  for (let i = 0; i < legs.length; i += 1) {
    if (legs[i] !== 'single') continue;
    if (singlesRemaining > 0) {
      budgets[i] = 1;
      singlesRemaining -= 1;
    }
  }
  const forSearch = singlesRemaining;
  const base = searchOrder.length > 0 ? Math.floor(forSearch / searchOrder.length) : 0;
  const remainder = searchOrder.length > 0 ? forSearch % searchOrder.length : 0;
  searchOrder.forEach((order, index) => {
    budgets[order] = base + (index < remainder ? 1 : 0);
  });
  return budgets;
}

function specialistTool(
  route: string,
  tools: GatherTools,
): ((args: Record<string, unknown>) => Promise<unknown>) | undefined {
  switch (route) {
    case 'research':
      return tools.research;
    case 'github':
      return tools.github;
    case 'social':
      return tools.social;
    case 'video':
      return tools.video;
    case 'kg':
      return tools.kg;
    default:
      return undefined;
  }
}

interface LegFetch {
  url: string;
  title: string;
  index: number;
  body?: string;
  failed: boolean;
}

interface LegResult {
  order: number;
  searchFailed: boolean;
  raw?: unknown;
  fetches: LegFetch[];
  /** Round fetch reserve exhausted before this leg: zero fetches, no tool call. */
  fetchSkipped?: boolean;
}

function matchQuestionIds(state: AgentState, body: string): string[] {
  const open = state.questions.filter((q) => q.status === 'open');
  const candidates = open.length > 0 ? open : state.questions;
  if (candidates.length === 0) return [];
  const lower = body.toLowerCase();
  const matched = candidates.filter((q) => {
    const tokens = q.question.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
    return tokens.some((token) => token.length >= 4 && lower.includes(token));
  });
  return (matched.length > 0 ? matched : candidates).map((q) => q.id);
}

export async function gatherExecutor(intents: GatherIntent[], round: number, ctx: GatherExecutorContext): Promise<GatherOutcome> {
  const laneCaps: Record<GatherLane, number> = { ...DEFAULT_LANE_CAPS, ...ctx.budgets?.laneCaps };
  const roundFetchCaps = ctx.budgets?.roundFetchCaps ?? DEFAULT_ROUND_FETCH_CAPS;
  const budgets = {
    maxSearches: ctx.budgets?.maxSearches ?? AGENT_DEFAULT_BUDGETS.maxSearches,
    maxFetches: ctx.budgets?.maxFetches ?? AGENT_DEFAULT_BUDGETS.maxFetches,
    maxGatherActions: ctx.budgets?.maxGatherActions ?? AGENT_DEFAULT_BUDGETS.maxGatherActions,
    laneCaps,
  };
  const outcome: GatherOutcome = {
    admitted: [],
    candidates: [],
    warnings: [],
    searchesUsed: 0,
    fetchesUsed: 0,
    queriesSearched: [],
    queryRejected: 0,
    webContent: [],
    perAction: [],
  };
  const { planned, warnings } = planActions(intents, ctx);
  outcome.warnings.push(...warnings);

  // Ledger first (record order = dispatch order = merge order), stopping the
  // moment the search budget fills — mirrors the legacy break-before-record.
  // Degraded actions record under 'web' (they execute as web_search).
  const legs: PlannedAction[] = [];
  const lanePlanned = new Map<GatherLane, number>();
  for (const action of planned) {
    if (action.skipReason !== undefined) {
      outcome.perAction[action.order] = { route: action.route, degraded: action.degraded, skipped: action.skipReason };
      continue;
    }
    const lane: GatherLane = action.degraded ? 'web' : (action.route as GatherLane);
    const laneUsed = (ctx.counters.laneActionsUsed?.[lane] ?? 0) + (lanePlanned.get(lane) ?? 0);
    if (laneUsed >= budgets.laneCaps[lane]) {
      outcome.warnings.push(cappedWarning(`lane budget exhausted (${lane}); action skipped`));
      outcome.perAction[action.order] = { route: action.route, degraded: action.degraded, skipped: 'lane_exhausted' };
      continue;
    }
    // Global envelope gate (Wave 5): shared exhaustion predicate with
    // stopPolicy — the ONLY definition of "no action dispatchable". The
    // lane refusal above already guarantees this action's lane has room, so a
    // refusal here means the envelope is spent (web-search headroom is checked
    // separately below). Admissible lanes ride the frozen snapshot; compat
    // mode (no snapshot) degrades every specialist leg to web, so web is the
    // only admissible lane there.
    const admissible: readonly GatherLane[] =
      ctx.snapshot === undefined ? (['web'] as const) : admissibleGatherLanes(ctx.snapshot);
    const mergedLaneUsed: Partial<Record<GatherLane, number>> = {
      ...(ctx.counters.laneActionsUsed ?? {}),
    };
    for (const [plannedLane, planned] of lanePlanned) {
      mergedLaneUsed[plannedLane] = (mergedLaneUsed[plannedLane] ?? 0) + planned;
    }
    // Search-consuming legs only: web_search dispatches + degraded specialists
    // riding web. web_fetch reads a URL directly (never a search slot) and
    // specialist-native legs never touch searchesUsed — counting them here
    // would let fetch-only legs veto search dispatch via the shared predicate.
    const searchPlanned = legs.reduce(
      (sum, leg) => sum + (consumesSearchSlot(leg) ? 1 : 0),
      0,
    );
    // Pending direct-URL reads: web_fetch legs already ledger-accepted this
    // round (in `legs`, not yet executed) plus the current candidate when it
    // is one — demand mirroring the searchPlanned spend pattern above.
    // The current action counts: otherwise the first web_fetch of a
    // searches-exhausted round reads pending 0 and vetoes itself.
    const pendingWebFetches =
      legs.reduce((sum, leg) => sum + (leg.intent.kind === 'web_fetch' ? 1 : 0), 0) +
      (action.intent.kind === 'web_fetch' ? 1 : 0);
    if (
      !canDispatchAnyAction(
        {
          gatherActionsUsed: (ctx.counters.gatherActionsUsed ?? 0) + legs.length,
          laneActionsUsed: mergedLaneUsed,
          searchesUsed: ctx.counters.searchesUsed + searchPlanned,
          pendingWebFetches,
          fetchesUsed: ctx.counters.fetchesUsed,
          admissibleLanes: admissible,
        },
        {
          maxSearches: budgets.maxSearches,
          maxGatherActions: budgets.maxGatherActions,
          laneCaps: budgets.laneCaps,
          maxFetches: budgets.maxFetches,
        },
      )
    ) {
      outcome.warnings.push(cappedWarning('gather envelope exhausted; action skipped'));
      outcome.perAction[action.order] = { route: action.route, degraded: action.degraded, skipped: 'budget_exhausted' };
      continue;
    }
    // maxSearches is strictly web-lane scope (Wave 5): only web-effective
    // SEARCH legs (native web_search, or degraded specialists riding web)
    // check it. Specialist legs with a live tool never touch searchesUsed, and
    // web_fetch is explicitly exempt: it consumes a gather slot + one fetch
    // attempt, never a search slot — so a pending web_fetch still dispatches
    // when maxSearches is exhausted. (stopPolicy in agent-policy.ts now shares
    // this fetch-awareness via the same canDispatchAnyAction predicate.)
    const isFetchRead = action.intent.kind === 'web_fetch';
    if (lane === 'web' && !isFetchRead && ctx.counters.searchesUsed + searchPlanned >= budgets.maxSearches) {
      outcome.warnings.push(cappedWarning('search budget exhausted; action skipped'));
      outcome.perAction[action.order] = { route: action.route, degraded: action.degraded, skipped: 'budget_exhausted' };
      continue;
    }
    const recorded = ctx.state.recordQuery({
      query: action.query,
      // web_fetch records under its own ledger route (not 'web'): the read is
      // a URL fetch, never a search, and dedupes against identical web_fetch
      // reads like every other intent.
      route: action.intent.kind === 'web_fetch' ? 'web_fetch' : action.degraded ? 'web' : action.route,
      ...(action.questionId === undefined ? {} : { questionId: action.questionId }),
    });
    if ('rejected' in recorded) {
      if (recorded.rejected.reason === 'query limit reached') outcome.queryRejected += 1;
      outcome.perAction[action.order] = { route: action.route, degraded: action.degraded, skipped: recorded.rejected.reason };
      continue;
    }
    legs.push(action);
    lanePlanned.set(lane, (lanePlanned.get(lane) ?? 0) + 1);
  }

  // Round-scoped fetch reserve: this round spends at most the round cap
  // (7/4/1 structural default) AND never past the total fetch budget.
  // Allocation rides fetch-capable legs ONLY (post-degradation): web_search
  // legs (native or degraded-to-web) split the reserve floor+remainder in
  // ledger order, web_fetch legs cost exactly 1 each deducted first, and
  // specialist-native legs (no fetch surface) get zero — otherwise they burn
  // allocation the web leg starves on.
  const roundCap = roundFetchCaps[Math.min(Math.max(1, round), roundFetchCaps.length) - 1] as number;
  const fetchRemaining = Math.min(roundCap, Math.max(0, budgets.maxFetches - ctx.counters.fetchesUsed));
  const fetchBudgets = allocateFetchBudgets(
    legs.map((leg) => (leg.intent.kind === 'web_fetch' ? 'single' : (leg.degraded ? 'web' : leg.route) === 'web' ? 'search' : 'none')),
    fetchRemaining,
  );

  const settled = await Promise.allSettled(
    legs.map(async (action, legOrder): Promise<LegResult> => {
      const effectiveRoute = action.degraded ? 'web' : action.route;
      // web_fetch: direct single-URL read — no search, exactly one fetch
      // attempt (success or failure) when the round reserve grants it a
      // budget, zero fetches when the reserve is spent. Never touches the
      // search budget.
      if (action.intent.kind === 'web_fetch') {
        if ((fetchBudgets[legOrder] ?? 0) <= 0) {
          return { order: action.order, searchFailed: false, fetches: [], fetchSkipped: true };
        }
        const url = action.intent.url;
        try {
          const body = await ctx.tools.fetchText(url);
          return { order: action.order, searchFailed: false, fetches: [{ url, title: url, index: 0, body, failed: false }] };
        } catch {
          return { order: action.order, searchFailed: false, fetches: [{ url, title: url, index: 0, failed: true }] };
        }
      }
      if (effectiveRoute === 'web') {
        let hits: Array<{ title: string; url: string; snippet?: string }>;
        try {
          hits = await ctx.tools.search(action.query);
        } catch {
          return { order: action.order, searchFailed: true, fetches: [] };
        }
        const filtered = (Array.isArray(hits) ? hits : [])
          .filter((hit) => typeof hit?.url === 'string' && /^https?:\/\//i.test(hit.url))
          .slice(0, AGENT_MAX_FETCH_ROUNDS)
          .slice(0, fetchBudgets[legOrder] ?? 0);
        const fetches: LegFetch[] = [];
        for (let index = 0; index < filtered.length; index += 1) {
          const hit = filtered[index]!;
          try {
            const body = await ctx.tools.fetchText(hit.url);
            fetches.push({ url: hit.url, title: hit.title || hit.url, index, body, failed: false });
          } catch {
            fetches.push({ url: hit.url, title: hit.title || hit.url, index, failed: true });
          }
        }
        return { order: action.order, searchFailed: false, fetches };
      }
      const tool = specialistTool(effectiveRoute, ctx.tools);
      if (tool === undefined) return { order: action.order, searchFailed: true, fetches: [] };
      try {
        const raw = await tool(action.args);
        return { order: action.order, searchFailed: false, raw, fetches: [] };
      } catch {
        return { order: action.order, searchFailed: true, fetches: [] };
      }
    }),
  );

  // Merge in ledger order, never completion order. allSettled preserves input
  // order, but index by action order explicitly.
  const byOrder = new Map<number, LegResult>();
  settled.forEach((entry, legOrder) => {
    if (entry.status === 'fulfilled') byOrder.set(legs[legOrder]!.order, entry.value);
  });
  let fetchSpent = 0;
  for (const action of legs) {
    const effectiveRoute = action.degraded ? 'web' : action.route;
    const questionIds = action.questionId === undefined ? undefined : [action.questionId];
    outcome.perAction[action.order] = { route: action.route, degraded: action.degraded };
    const result = byOrder.get(action.order);
    // searchesUsed counts web-search ATTEMPTS (success or failure) — one
    // definition shared with the legacy core paths, which increment per
    // dispatched search. A failed search still costs the search budget; the
    // envelope spend was already recorded at dispatch time. Specialist legs
    // never touch this counter (own lane caps + shared envelope only), and
    // web_fetch never touches it either (fetch reserve only).
    if (effectiveRoute === 'web' && action.intent.kind !== 'web_fetch') outcome.searchesUsed += 1;
    if (result === undefined || result.searchFailed) {
      outcome.warnings.push(cappedWarning(effectiveRoute === 'web' ? 'search failed; query skipped' : `${effectiveRoute} gather failed; action skipped`));
      continue;
    }
    outcome.queriesSearched.push(action.query);
    if (result.fetchSkipped === true) {
      outcome.warnings.push(cappedWarning('fetch budget exhausted; web_fetch skipped'));
      continue;
    }
    if (effectiveRoute === 'web') {
      for (const fetch of result.fetches) {
        if (ctx.counters.fetchesUsed + fetchSpent >= budgets.maxFetches) break;
        fetchSpent += 1;
        outcome.fetchesUsed += 1;
        if (fetch.failed) {
          outcome.warnings.push(cappedWarning(`fetch round ${fetch.index} failed; passage skipped`));
          continue;
        }
        const body = fetch.body ?? '';
        if (body.trim() === '') continue;
        outcome.webContent.push({ url: fetch.url, title: fetch.title, body });
        const admission = admitFromFetch(
          ctx.state,
          { kind: 'fetch', url: fetch.url, canonicalUrl: fetch.url, content: body },
          questionIds ?? matchQuestionIds(ctx.state, body),
          round,
        );
        outcome.admitted.push(...admission.evidence);
      }
      continue;
    }
    admitSpecialist(action, result.raw, questionIds, round, ctx, outcome);
  }
  return outcome;
}

function admitSpecialist(
  action: PlannedAction,
  raw: unknown,
  questionIds: string[] | undefined,
  round: number,
  ctx: GatherExecutorContext,
  outcome: GatherOutcome,
): void {
  const route = action.route;
  const qids = (hint: string): string[] => questionIds ?? matchQuestionIds(ctx.state, hint);
  switch (route) {
    case 'research': {
      // W1 boundary: buildNativeGatherTools pre-adapts native envelopes into
      // {candidates, evidenceInputs}; legacy top-level arrays still parse.
      const adapted = isAdaptedGatherPayload(raw) && raw.source === 'research' ? raw : undefined;
      if (adapted !== undefined) outcome.warnings.push(...adapted.warnings.map((warning) => cappedWarning(warning)));
      const rows = adapted !== undefined ? adapted.evidenceInputs : pickArray(raw, ['abstracts', 'results', 'items', 'entries']);
      // W2: pre-typed D6 candidates forward intact (follow-up identity kept);
      // legacy top-level arrays degrade to generic display-only rows.
      if (adapted !== undefined) {
        outcome.candidates.push(...adapted.candidates);
      } else {
        outcome.candidates.push(
          ...collectCandidates(
            'research',
            rows.map((row) => ({
              ...(asNonEmptyString(row['title']) === undefined ? {} : { title: row['title'] as string }),
              ...(httpUrl(row) === undefined ? {} : { url: httpUrl(row) as string }),
              ...(asNonEmptyString(row['snippet'] ?? row['abstract']) === undefined
                ? {}
                : { snippet: (row['snippet'] ?? row['abstract']) as string }),
            })),
          ),
        );
      }
      for (const row of rows) {
        const abstract = asNonEmptyString(row['abstract']);
        if (abstract === undefined) continue;
        // Client-side year range filter: the native research surface reads
        // yearFrom only, so out-of-range rows stay candidates (listed above)
        // but never become evidence.
        if (!researchYearInRange(row, action.intent)) continue;
        const url = httpUrl(row);
        const admission = admitResearchAbstract(
          ctx.state,
          {
            abstract,
            ...(url === undefined ? {} : { canonicalUrl: url }),
            provider: asNonEmptyString(row['provider']) ?? 'research',
            query: action.query,
          },
          qids(abstract),
          round,
        );
        outcome.admitted.push(...admission.evidence);
      }
      return;
    }
    case 'github': {
      // W1 boundary: pre-adapted native envelopes arrive as
      // {candidates, evidenceInputs}; legacy top-level arrays still parse.
      const adapted = isAdaptedGatherPayload(raw) && raw.source === 'github' ? raw : undefined;
      if (adapted !== undefined) outcome.warnings.push(...adapted.warnings.map((warning) => cappedWarning(warning)));
      const rows = adapted !== undefined ? adapted.evidenceInputs : pickArray(raw, ['contents', 'results', 'items', 'files']);
      // W2: pre-typed D6 candidates forward intact (follow-up identity kept);
      // legacy top-level arrays degrade to generic display-only rows.
      if (adapted !== undefined) {
        outcome.candidates.push(...adapted.candidates);
      } else {
        outcome.candidates.push(
          ...collectCandidates(
            'github',
            rows.map((row) => ({
              ...(asNonEmptyString(row['title'] ?? row['path']) === undefined
                ? {}
                : { title: (row['title'] ?? row['path']) as string }),
              ...(httpUrl(row) === undefined ? {} : { url: httpUrl(row) as string }),
              ...(asNonEmptyString(row['snippet']) === undefined ? {} : { snippet: row['snippet'] as string }),
            })),
          ),
        );
      }
      for (const row of rows) {
        const content = asNonEmptyString(row['content'] ?? row['text'] ?? row['body']);
        const url = httpUrl(row);
        if (content === undefined || url === undefined) continue;
        const admission = admitGithubContent(
          ctx.state,
          {
            content,
            canonicalUrl: url,
            ...(asNonEmptyString(row['ref']) === undefined ? {} : { ref: row['ref'] as string }),
          },
          qids(content),
          round,
        );
        outcome.admitted.push(...admission.evidence);
      }
      return;
    }
    case 'social': {
      const rows = pickArray(raw, ['bodies', 'posts', 'results', 'items']);
      outcome.candidates.push(
        ...collectCandidates(
          'social',
          rows.map((row) => ({
            ...(asNonEmptyString(row['title'] ?? row['author']) === undefined
              ? {}
              : { title: (row['title'] ?? row['author']) as string }),
            ...(httpUrl(row) === undefined ? {} : { url: httpUrl(row) as string }),
            ...(asNonEmptyString(row['snippet'] ?? row['body'] ?? row['text']) === undefined
              ? {}
              : { snippet: (row['snippet'] ?? row['body'] ?? row['text']) as string }),
          })),
        ),
      );
      for (const row of rows) {
        const body = asNonEmptyString(row['body'] ?? row['text']);
        const url = httpUrl(row);
        if (body === undefined || url === undefined) continue;
        const admission = admitSocialBody(ctx.state, { body, canonicalUrl: url }, qids(body), round);
        outcome.admitted.push(...admission.evidence);
      }
      return;
    }
    case 'video': {
      const rows = pickArray(raw, ['segments', 'transcript', 'results', 'items']);
      outcome.candidates.push(
        ...collectCandidates(
          'video',
          rows.map((row) => ({
            ...(asNonEmptyString(row['title']) === undefined ? {} : { title: row['title'] as string }),
            ...(httpUrl(row) === undefined ? {} : { url: httpUrl(row) as string }),
            ...(asNonEmptyString(row['snippet'] ?? row['segment'] ?? row['text']) === undefined
              ? {}
              : { snippet: (row['snippet'] ?? row['segment'] ?? row['text']) as string }),
          })),
        ),
      );
      for (const row of rows) {
        const segment = asNonEmptyString(row['segment'] ?? row['text']);
        const url = httpUrl(row);
        if (segment === undefined || url === undefined) continue;
        const timestamp = typeof row['timestamp'] === 'number' && Number.isFinite(row['timestamp']) && row['timestamp'] >= 0 ? row['timestamp'] : 0;
        const admission = admitVideoTranscriptSegment(ctx.state, { segment, timestamp, canonicalUrl: url }, qids(segment), round);
        outcome.admitted.push(...admission.evidence);
      }
      return;
    }
    case 'kg': {
      // W1 boundary + D1: pre-adapted KG search payloads carry candidates
      // only (evidenceInputs always empty); legacy fields arrays still parse.
      const adapted = isAdaptedGatherPayload(raw) && raw.source === 'kg' ? raw : undefined;
      if (adapted !== undefined) outcome.warnings.push(...adapted.warnings.map((warning) => cappedWarning(warning)));
      const rows = adapted !== undefined ? adapted.evidenceInputs : pickArray(raw, ['fields', 'entities', 'results', 'items']);
      // W2: pre-typed D6 candidates forward intact (follow-up identity kept);
      // legacy top-level arrays degrade to generic display-only rows.
      if (adapted !== undefined) {
        outcome.candidates.push(...adapted.candidates);
      } else {
        outcome.candidates.push(
          ...collectCandidates(
            'kg',
            rows.map((row) => ({
              ...(asNonEmptyString(row['title'] ?? row['name']) === undefined
                ? {}
                : { title: (row['title'] ?? row['name']) as string }),
              ...(httpUrl(row) === undefined ? {} : { url: httpUrl(row) as string }),
              ...(asNonEmptyString(row['snippet'] ?? row['value'] ?? row['text']) === undefined
                ? {}
                : { snippet: (row['snippet'] ?? row['value'] ?? row['text']) as string }),
            })),
          ),
        );
      }
      const fields = rows
        .map((row) => ({
          nodeId: asNonEmptyString(row['nodeId'] ?? row['id']),
          field: asNonEmptyString(row['field'] ?? row['name']),
          value: asNonEmptyString(row['value'] ?? row['text']),
        }))
        .filter((field): field is { nodeId: string; field: string; value: string } =>
          field.nodeId !== undefined && field.field !== undefined && field.value !== undefined,
        );
      if (fields.length === 0) return;
      const admission = admitKgFields(
        ctx.state,
        {
          provider: asNonEmptyString(asRecord(raw)?.['provider']) ?? 'kg',
          query: action.query,
          fields,
        },
        qids(fields.map((field) => field.value).join('\n')),
        round,
      );
      outcome.admitted.push(...admission.evidence);
      return;
    }
    default: {
      outcome.warnings.push(cappedWarning(`unknown gather route: ${route}; action skipped`));
    }
  }
}

/** Wave 9 (D4) capability truth: specialist lanes the executor can actually
 *  run. Single source of truth — agent-capabilities.ts intersects the machine
 *  snapshot against this list so planner-visible lanes ⊆ executor-supported
 *  lanes. Social/video have no native surface this cycle (deferred together
 *  with the Bilibili platform discriminator); buildNativeGatherTools provides
 *  exactly research/github/kg below, nothing else. */
export const EXECUTOR_SUPPORTED_SPECIALIST_LANES = ['research', 'github', 'kg'] as const;

export type ExecutorSupportedSpecialistLane = (typeof EXECUTOR_SUPPORTED_SPECIALIST_LANES)[number];

/** Prod tool wiring: web legs ride the caller's search/fetch; research, github
 *  and kg ride callNativeTool; social/video have no native surface yet, so the
 *  executor degrades them to web + warning (see plan known unknowns). */
export function buildNativeGatherTools(deps: {
  search: GatherTools['search'];
  fetchText: GatherTools['fetchText'];
  callNative: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}): GatherTools {
  return {
    search: deps.search,
    fetchText: deps.fetchText,
    research: (args) => adaptNativeCall('research', args),
    github: (args) => adaptNativeCall('github', args),
    kg: (args) => adaptNativeCall('kg', args),
  };

  // W1 boundary: normalize the raw native envelope before the executor sees
  // it. Malformed payloads stay a bounded empty payload + warning, never a
  // throw past the executor. A NATIVE call exception is NOT caught here: it
  // propagates to gatherExecutor's per-leg failure boundary (allSettled leg
  // path), which records the normal failed-gather shape ('<route> gather
  // failed; action skipped', query absent from queriesSearched) without
  // killing sibling legs — catching here would feed undefined into the
  // adapter and misreport the failure as 'unexpected native payload'.
  async function adaptNativeCall(name: 'research' | 'github' | 'kg', args: Record<string, unknown>): Promise<unknown> {
    const result = await deps.callNative(name, args);
    if (name === 'research') return adaptResearchResult(result);
    if (name === 'github') return adaptGithubResult(result);
    return adaptKgResult(result);
  }
}

/** Evidence-mapping helper: structured-identity entries (canonicalUrl '')
 *  are not URLs and must never join URL grouping. Returns the normalized URL
 *  or undefined for sentinel entries. */
export function evidenceUrl(entry: { sourceRef: { canonicalUrl: string } }): string | undefined {
  if (entry.sourceRef.canonicalUrl === '') return undefined;
  return normalizeUrl(entry.sourceRef.canonicalUrl);
}
