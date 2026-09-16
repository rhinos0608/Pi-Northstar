// Agent policy (Phase 2): budgets, deterministic stop rules, semantic growth,
// and conflict detection. Pure functions only — no model calls, no I/O.
// The evaluator proposes (shouldContinue); this module decides.

import {
  type AgentEvidence,
  corroboratingFingerprint,
  isNearDuplicate,
} from './agent-state.js';

/** Approved default budgets — tests read the caps from here. */
export const AGENT_DEFAULT_BUDGETS = {
  maxRounds: 3,
  maxSearches: 4,
  maxFetches: 12,
  maxUtilityCalls: 8,
  maxGatherActions: 6,
} as const;

/** Hard ceilings: resolveBudgets rejects past these, never clamps. */
export const MAX_ROUNDS = 6;
export const MAX_SEARCHES = 12;
export const MAX_FETCHES = 24;
export const MAX_UTILITY_CALLS = 16;
/** Global acquisition envelope ceiling (total gather actions per job). */
export const MAX_GATHER_ACTIONS = 18;
/** Per-lane ceiling: every lane rejects past this, never clamps. */
export const MAX_LANE_ACTIONS = 12;
/** Cap on conflict entries per detectConflicts call. */
export const MAX_CONFLICTS = 8;

/** Gather lanes: one cap each. Width N = N actions total per round ACROSS lanes. */
export type GatherLane = 'web' | 'research' | 'github' | 'social' | 'video' | 'kg';

export const GATHER_LANES: readonly GatherLane[] = ['web', 'research', 'github', 'social', 'video', 'kg'] as const;

/** Per-lane action caps (total per job). Pinned defaults; bench-adjustable. */
export interface LaneCaps {
  web: number;
  research: number;
  github: number;
  social: number;
  video: number;
  kg: number;
}

/** Balanced-lane defaults: web carries the floor, specialists bounded. */
export const DEFAULT_LANE_CAPS: LaneCaps = {
  web: 6,
  research: 4,
  github: 4,
  social: 3,
  video: 2,
  kg: 3,
} as const;

/** Deep-profile lane floors: raised specialist caps (bench-adjustable). */
export const DEEP_LANE_CAPS: LaneCaps = {
  web: 6,
  research: 8,
  github: 8,
  social: 6,
  video: 4,
  kg: 6,
} as const;

/**
 * Round-scoped fetch reserve under the 12-fetch total: round 1 cap 7,
 * round 2 cap 4, round 3 cap 1. Reservation is structural; the exact split
 * is a bench concern. Operator-lower-only: overrides shrink entries, never grow.
 */
export const DEFAULT_ROUND_FETCH_CAPS: readonly [number, number, number] = [7, 4, 1] as const;

/** Code-owned width profiles; the model never chooses width. */
export type GatherProfile = 'balanced' | 'deep' | 'narrow';

/**
 * Descending width schedule per profile (benchmark candidate [3,2,1], not
 * settled architecture). "Up to" semantics: N gaps dispatch at most N tasks.
 */
export const WIDTH_SCHEDULES: Record<GatherProfile, readonly [number, number, number]> = {
  balanced: [3, 2, 1],
  deep: [3, 2, 1],
  narrow: [1, 1, 1],
} as const;

/** Width for a 1-based round (past-schedule rounds pin to the last entry). */
export function widthForRound(profile: GatherProfile, round: number): number {
  const schedule = WIDTH_SCHEDULES[profile];
  return schedule[Math.min(Math.max(1, round), schedule.length) - 1] as number;
}

/**
 * Code-owned profile derivation (deterministic, never model-chosen): deep
 * from explicit job depth; narrow from a single required question with no
 * specialist need; balanced default.
 */
export function deriveGatherProfile(args: {
  depth?: string;
  requiredQuestionCount: number;
  specialistNeeded: boolean;
}): GatherProfile {
  if (args.depth === 'deep') return 'deep';
  if (args.requiredQuestionCount === 1 && !args.specialistNeeded) return 'narrow';
  return 'balanced';
}

/** Effective per-lane caps: deep raises specialist lanes to the deep floors. */
export function effectiveLaneCaps(budgets: AgentBudgets, profile: GatherProfile): LaneCaps {
  const base: LaneCaps = { ...DEFAULT_LANE_CAPS, ...budgets.laneCaps };
  if (profile !== 'deep') return base;
  return {
    web: base.web,
    research: Math.max(base.research, DEEP_LANE_CAPS.research),
    github: Math.max(base.github, DEEP_LANE_CAPS.github),
    social: Math.max(base.social, DEEP_LANE_CAPS.social),
    video: Math.max(base.video, DEEP_LANE_CAPS.video),
    kg: Math.max(base.kg, DEEP_LANE_CAPS.kg),
  };
}

/**
 * Admissible gather lanes for a frozen capability snapshot (structural param:
 * pass the EffectiveCapabilitiesSnapshot straight in). Web/research/github
 * ride the always-available baseline; social/video/kg gate on live surfaces.
 */
export function admissibleGatherLanes(snapshot: {
  research: { usable: boolean };
  github: { usable: boolean };
  kg: { usable: boolean };
  video: { youtube: { usable: boolean }; bilibili: { usable: boolean } };
  social: Array<{ usable: boolean }>;
}): GatherLane[] {
  const lanes: GatherLane[] = ['web', 'research', 'github'];
  if (snapshot.social.some((entry) => entry.usable)) lanes.push('social');
  if (snapshot.video.youtube.usable || snapshot.video.bilibili.usable) lanes.push('video');
  if (snapshot.kg.usable) lanes.push('kg');
  return lanes;
}

/** Specialist capability per snapshot: any live lane beyond the web baseline.
 *  Capability truth only — NOT specialist need. Wave 7: profile derivation
 *  never reads this alone (a specialist-capable machine still narrows on a
 *  single web-only-intent question); need comes from planHasServableSpecialistNeed. */
export function snapshotHasSpecialistNeed(snapshot: Parameters<typeof admissibleGatherLanes>[0]): boolean {
  return admissibleGatherLanes(snapshot).some((lane) => lane !== 'web');
}

/**
 * Wave 7 specialist need: the PLAN needs a specialist lane the frozen snapshot
 * can actually serve — not bare machine capability. Routes arrive precomputed
 * (core maps normalized planner intents via intentRoute; 'web' = no specialist
 * signal). A non-web route counts only when the snapshot admits that lane, so a
 * degraded-to-web intent narrows instead of holding balanced. Snapshot absent =
 * true when any specialist route exists (conservative: no snapshot to prove the
 * degrade, fail toward more capacity).
 */
export function planHasServableSpecialistNeed(args: {
  routes: readonly string[];
  snapshot?: Parameters<typeof admissibleGatherLanes>[0];
}): boolean {
  const specialist = args.routes.filter((route) => route !== 'web');
  if (specialist.length === 0) return false;
  if (args.snapshot === undefined) return true;
  const servable = new Set<string>(admissibleGatherLanes(args.snapshot));
  return specialist.some((route) => servable.has(route));
}

/**
 * Wave 7 code-owned profile gate (policy-owned; the core supplies plan truth).
 * Deep stays explicit-only. A missing/invalid plan (planValid false: planner
 * absent, threw, or normalizePlan rejected) stays balanced — fail toward more
 * capacity, never narrow on an unexpressed need. Query-shape heuristics live
 * nowhere here by design: specialist-shaped queries surface as non-web planner
 * intents, and the invalid-plan fallback already covers the planner missing
 * them. Single required question + servable-specialist-need false narrows.
 */
export function deriveProfileForPlan(args: {
  depth?: string;
  requiredQuestionCount: number;
  routes: readonly string[];
  snapshot?: Parameters<typeof admissibleGatherLanes>[0];
  planValid: boolean;
}): GatherProfile {
  if (args.depth === 'deep') return 'deep';
  if (!args.planValid) return 'balanced';
  return deriveGatherProfile({
    ...(args.depth === undefined ? {} : { depth: args.depth }),
    requiredQuestionCount: args.requiredQuestionCount,
    specialistNeeded: planHasServableSpecialistNeed({ routes: args.routes, ...(args.snapshot === undefined ? {} : { snapshot: args.snapshot }) }),
  });
}

/**
 * Role-aware utility reservation: planner 1 + synthesis 1 + verify/repair 2
 * are guaranteed BEFORE evaluators spend the remainder, so evaluator
 * pressure can never starve synthesis or verify/repair capacity.
 *
 * Verify/repair split (Wave 6): the 2-call verify/repair reserve is held
 * for repair+reverify, not for initial verification. The verification stage
 * caps its semantic calls at (maxUtilityCalls - utilityCallsUsed - 2) while
 * a repairer is present, so the repair gate (headroom >= 2) stays reachable
 * after verification runs. When headroom at or under the reserve, the stage
 * runs deterministic-only verification (zero semantic calls) instead of
 * eating the reserve. No repairer = no repair stage = no reserve held.
 */
export const UTILITY_RESERVE_PLANNER = 1;
export const UTILITY_RESERVE_SYNTHESIS = 1;
export const UTILITY_RESERVE_VERIFY_REPAIR = 2;

export interface UtilityBudgetSplit {
  planner: number;
  synthesis: number;
  verifyRepair: number;
  evaluator: number;
}

/** Evaluator spend cap under the reserves (floor 0, never negative). */
export function utilityBudgetSplit(maxUtilityCalls: number): UtilityBudgetSplit {
  return {
    planner: UTILITY_RESERVE_PLANNER,
    synthesis: UTILITY_RESERVE_SYNTHESIS,
    verifyRepair: UTILITY_RESERVE_VERIFY_REPAIR,
    evaluator: Math.max(
      0,
      maxUtilityCalls - UTILITY_RESERVE_PLANNER - UTILITY_RESERVE_SYNTHESIS - UTILITY_RESERVE_VERIFY_REPAIR,
    ),
  };
}

/** Evaluator headroom this round: skip the evaluator call when reserves are at risk. */
export function evaluatorUtilityHeadroom(args: {
  maxUtilityCalls: number;
  utilityCallsUsed: number;
  synthesizerPresent: boolean;
  verifierPresent: boolean;
}): number {
  const reserve =
    (args.synthesizerPresent ? UTILITY_RESERVE_SYNTHESIS : 0) +
    (args.verifierPresent ? UTILITY_RESERVE_VERIFY_REPAIR : 0);
  return args.maxUtilityCalls - reserve - args.utilityCallsUsed;
}

/** Initial-verification semantic call cap: the repair/reverify reserve stays
 *  out of reach while a repairer is present, so the repair gate (headroom
 *  >= UTILITY_RESERVE_VERIFY_REPAIR after verification) is actually
 *  reachable. Zero cap = deterministic-only verification (no semantic
 *  spend) instead of eating the reserve. No repairer = no repair stage, so
 *  verification may spend the full headroom. Floor 0, never negative. */
export function verifyUtilityHeadroom(args: {
  maxUtilityCalls: number;
  utilityCallsUsed: number;
  repairerPresent: boolean;
}): number {
  const reserve = args.repairerPresent ? UTILITY_RESERVE_VERIFY_REPAIR : 0;
  return Math.max(0, args.maxUtilityCalls - args.utilityCallsUsed - reserve);
}

/** resolveBudgets output: envelope fields always populated. */
export interface ResolvedAgentBudgets extends AgentBudgets {
  maxGatherActions: number;
  laneCaps: LaneCaps;
  roundFetchCaps: [number, number, number];
}

export interface AgentBudgets {
  maxRounds: number;
  maxSearches: number;
  maxFetches: number;
  maxUtilityCalls: number;
  /** Global acquisition envelope: total gather actions per job across ALL lanes. Optional; resolveBudgets fills the default. */
  maxGatherActions?: number;
  laneCaps?: LaneCaps;
  /** Round-scoped fetch reserve (operator-lower-only). Optional; resolveBudgets fills the default. */
  roundFetchCaps?: [number, number, number];
  deadlineMs?: number;
}

/**
 * Fill defaults and validate. Reject-not-clamp: any violation throws
 * RangeError with an exact message (house style: agent-contract budgets).
 */
export function resolveBudgets(
  partial?: Omit<Partial<AgentBudgets>, 'laneCaps'> & { laneCaps?: Partial<LaneCaps> },
): ResolvedAgentBudgets {
  const merged: ResolvedAgentBudgets = {
    maxRounds: partial?.maxRounds ?? AGENT_DEFAULT_BUDGETS.maxRounds,
    maxSearches: partial?.maxSearches ?? AGENT_DEFAULT_BUDGETS.maxSearches,
    maxFetches: partial?.maxFetches ?? AGENT_DEFAULT_BUDGETS.maxFetches,
    maxUtilityCalls: partial?.maxUtilityCalls ?? AGENT_DEFAULT_BUDGETS.maxUtilityCalls,
    maxGatherActions: partial?.maxGatherActions ?? AGENT_DEFAULT_BUDGETS.maxGatherActions,
    laneCaps: { ...DEFAULT_LANE_CAPS, ...partial?.laneCaps },
    roundFetchCaps: partial?.roundFetchCaps === undefined ? [...DEFAULT_ROUND_FETCH_CAPS] as [number, number, number] : [...partial.roundFetchCaps] as [number, number, number],
    ...(partial?.deadlineMs === undefined ? {} : { deadlineMs: partial.deadlineMs }),
  };
  const checkPositiveInt = (name: 'maxRounds' | 'maxSearches' | 'maxFetches' | 'maxUtilityCalls' | 'maxGatherActions', value: number): void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  };
  checkPositiveInt('maxRounds', merged.maxRounds);
  checkPositiveInt('maxSearches', merged.maxSearches);
  checkPositiveInt('maxFetches', merged.maxFetches);
  checkPositiveInt('maxUtilityCalls', merged.maxUtilityCalls);
  checkPositiveInt('maxGatherActions', merged.maxGatherActions);
  for (const lane of GATHER_LANES) {
    const value = merged.laneCaps[lane];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new RangeError(`laneCaps.${lane} must be a positive integer`);
    }
    if (value > MAX_LANE_ACTIONS) throw new RangeError(`laneCaps.${lane} exceeds maximum of ${MAX_LANE_ACTIONS}`);
  }
  if (!Array.isArray(merged.roundFetchCaps) || merged.roundFetchCaps.length !== 3) {
    throw new RangeError('roundFetchCaps must be a 3-tuple of positive integers');
  }
  merged.roundFetchCaps.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new RangeError('roundFetchCaps must be a 3-tuple of positive integers');
    }
    const ceiling = DEFAULT_ROUND_FETCH_CAPS[index] as number;
    if (value > ceiling) throw new RangeError(`roundFetchCaps[${index}] exceeds maximum of ${ceiling}`);
  });
  if (merged.maxRounds > MAX_ROUNDS) throw new RangeError(`maxRounds exceeds maximum of ${MAX_ROUNDS}`);
  if (merged.maxSearches > MAX_SEARCHES) throw new RangeError(`maxSearches exceeds maximum of ${MAX_SEARCHES}`);
  if (merged.maxFetches > MAX_FETCHES) throw new RangeError(`maxFetches exceeds maximum of ${MAX_FETCHES}`);
  if (merged.maxGatherActions > MAX_GATHER_ACTIONS) {
    throw new RangeError(`maxGatherActions exceeds maximum of ${MAX_GATHER_ACTIONS}`);
  }
  if (merged.maxUtilityCalls > MAX_UTILITY_CALLS) {
    throw new RangeError(`maxUtilityCalls exceeds maximum of ${MAX_UTILITY_CALLS}`);
  }
  if (merged.deadlineMs !== undefined) {
    if (typeof merged.deadlineMs !== 'number' || !Number.isFinite(merged.deadlineMs) || merged.deadlineMs <= 0) {
      throw new RangeError('deadlineMs must be greater than 0');
    }
  }
  return merged;
}

// --- Unified acquisition dispatch (Wave 5: budget unification) ---

/** Input state for the shared exhaustion predicate. */
export interface ActionDispatchState {
  /** Total gather actions consumed (global acquisition envelope spend). */
  gatherActionsUsed: number;
  /** Per-lane spend (absent lanes = 0). */
  laneActionsUsed?: Partial<Record<GatherLane, number>>;
  /** Web-lane searches consumed. Scoped strictly to the web lane: specialist
   *  successes never increment this (they ride gatherActionsUsed + lane caps). */
  searchesUsed: number;
  /** Pending direct-URL web_fetch reads (absent = 0). Fetch-aware web-lane
   *  headroom only; never waives the envelope or lane caps. */
  pendingWebFetches?: number;
  /** Fetches consumed (needed for the web-lane fetch fallback; absent =
   *  no fetch headroom, fail closed so existing callers read unchanged). */
  fetchesUsed?: number;
  /** Lanes the frozen snapshot admits for this job. */
  admissibleLanes: readonly GatherLane[];
}

/** Budget side of the shared exhaustion predicate. */
export interface ActionDispatchBudgets {
  maxSearches: number;
  maxGatherActions: number;
  laneCaps: LaneCaps;
  /** Total fetch budget (needed for the web-lane fetch fallback; absent =
   *  no fetch headroom, fail closed so existing callers read unchanged). */
  maxFetches?: number;
}

/**
 * ONE definition of acquisition exhaustion (Wave 5): an action is dispatchable
 * only under the global envelope AND inside a lane with cap headroom; the web
 * lane additionally needs web-search budget headroom (maxSearches is strictly
 * web-lane scope), OR a pending direct-URL web_fetch read with fetch-budget
 * headroom: fetches cost a gather slot + one fetch attempt, never a search
 * slot, so a pending web_fetch stays dispatchable when maxSearches is spent.
 * Executor planning and stopPolicy() both call this —
 * envelope-exhausted, lane-cap-exhausted, both-open, and both-exhausted states
 * read identically on both paths. Fetch/utility reserves live outside this
 * predicate (Wave 6 owns synthesis accounting; evaluatorUtilityHeadroom stays
 * where it is).
 *
 * Web-lane headroom rule: searchesUsed < maxSearches OR (pendingWebFetches > 0
 * AND fetchesUsed < maxFetches). New fields are optional and fail closed:
 * absent pendingWebFetches reads as 0, absent fetchesUsed/maxFetches reads as
 * no fetch headroom, so every pre-existing caller keeps its exact behavior.
 * Envelope + lane-cap checks are unchanged and decisive: fetch-awareness
 * never punches through them.
 */
export function canDispatchAnyAction(state: ActionDispatchState, budgets: ActionDispatchBudgets): boolean {
  if (state.gatherActionsUsed >= budgets.maxGatherActions) return false;
  return state.admissibleLanes.some((lane) => {
    if ((state.laneActionsUsed?.[lane] ?? 0) >= budgets.laneCaps[lane]) return false;
    if (lane === 'web' && state.searchesUsed >= budgets.maxSearches) {
      // Search budget spent: only a pending web_fetch with fetch headroom
      // keeps the web lane dispatchable (direct URL read, no search slot).
      if ((state.pendingWebFetches ?? 0) <= 0) return false;
      if (state.fetchesUsed === undefined || budgets.maxFetches === undefined) return false;
      if (state.fetchesUsed >= budgets.maxFetches) return false;
      return true;
    }
    return true;
  });
}

export type StopReason =
  | 'deadline'
  | 'all_required_grounded'
  | 'round_cap'
  | 'budget_exhausted'
  | 'no_progress'
  | 'no_queries'
  | 'continue'
  | 'evaluator_stop_advisory';

export interface StopPolicyContext {
  clockMs: number;
  deadlineMs?: number;
  round: number;
  roundsCompleted: number;
  searchesUsed: number;
  fetchesUsed: number;
  utilityCallsUsed: number;
  budgets: AgentBudgets;
  allRequiredGrounded: boolean;
  growthLastTwoRounds: [number, number];
  remainingNextQueries: string[];
  evaluatorRequestedContinue: boolean;
  /** Total executor gather actions consumed (absent = 0). */
  gatherActionsUsed?: number;
  /** Per-lane executor spend (absent lanes = 0). */
  laneActionsUsed?: Partial<Record<GatherLane, number>>;
  /**
   * Admissible lanes for this job. Present = lane-aware envelope stop;
   * absent = legacy branch (compat for callers without a capability
   * snapshot) which consults the same shared predicate with ['web'] as the
   * only admissible lane, plus the scalar search/fetch caps.
   */
  admissibleLanes?: GatherLane[];
  /** Pending direct-URL web_fetch reads (absent = 0). Fetch-aware web-lane
   *  headroom only; never waives envelope, lane caps, or the global fetch cap. */
  pendingWebFetches?: number;
}

// Load-bearing: the evaluator's shouldContinue is advisory only. It can keep
// a finished-looking loop going, but it can never stop one while required
// questions are ungrounded and budget remains — rules 2–6 run before the
// fallback, so code (not the model) declares victory.
export function stopPolicy(ctx: StopPolicyContext): { stop: boolean; reason: StopReason } {
  if (ctx.deadlineMs !== undefined && ctx.clockMs >= ctx.deadlineMs) return { stop: true, reason: 'deadline' };
  if (ctx.allRequiredGrounded) return { stop: true, reason: 'all_required_grounded' };
  if (ctx.roundsCompleted >= ctx.budgets.maxRounds) return { stop: true, reason: 'round_cap' };
  if (ctx.utilityCallsUsed >= ctx.budgets.maxUtilityCalls) return { stop: true, reason: 'budget_exhausted' };
  if (ctx.admissibleLanes !== undefined) {
    // Lane-aware stop: the global fetch cap stops here (the envelope never
    // waives it). maxSearches is NOT a scalar gate on this path: it is
    // strictly web-lane scope, so a job-wide kill on searchesUsed would end
    // the job while specialist lanes still have headroom. Web exhaustion is
    // decided by canDispatchAnyAction below (web lane checks searchesUsed)
    // plus the executor's own web-lane gate — the same definition the
    // executor plans against. Envelope + lane exhaustion share ONE
    // definition with executor planning via canDispatchAnyAction:
    // envelope-exhausted stops even with lane headroom (matches the executor
    // refusal), lane-cap-exhausted stops even with envelope headroom.
    if (ctx.fetchesUsed >= ctx.budgets.maxFetches) {
      return { stop: true, reason: 'budget_exhausted' };
    }
    const envelope = ctx.budgets.maxGatherActions ?? AGENT_DEFAULT_BUDGETS.maxGatherActions;
    const caps: LaneCaps = { ...DEFAULT_LANE_CAPS, ...ctx.budgets.laneCaps };
    if (
      !canDispatchAnyAction(
        {
          gatherActionsUsed: ctx.gatherActionsUsed ?? 0,
          ...(ctx.laneActionsUsed === undefined ? {} : { laneActionsUsed: ctx.laneActionsUsed }),
          searchesUsed: ctx.searchesUsed,
          ...(ctx.pendingWebFetches === undefined ? {} : { pendingWebFetches: ctx.pendingWebFetches }),
          fetchesUsed: ctx.fetchesUsed,
          admissibleLanes: ctx.admissibleLanes,
        },
        {
          maxSearches: ctx.budgets.maxSearches,
          maxGatherActions: envelope,
          laneCaps: caps,
          maxFetches: ctx.budgets.maxFetches,
        },
      )
    ) {
      return { stop: true, reason: 'budget_exhausted' };
    }
  } else {
    // Legacy (snapshot-absent) branch: no snapshot means no lane data, so the
    // only admissible lane is web. Exhaustion consults the SAME shared
    // predicate as the lane-aware branch (canDispatchAnyAction with ['web'])
    // so stop semantics are identical with or without a snapshot; the scalar
    // search/fetch caps below bind the web lane directly.
    const envelope = ctx.budgets.maxGatherActions ?? AGENT_DEFAULT_BUDGETS.maxGatherActions;
    const caps: LaneCaps = { ...DEFAULT_LANE_CAPS, ...ctx.budgets.laneCaps };
    // Legacy scalar search gate is fetch-aware like the shared predicate: a
    // pending web_fetch with fetch headroom waives the maxSearches kill
    // (direct URL read, no search slot). Fetch cap + envelope stay decisive.
    const pendingFetchHeadroom =
      (ctx.pendingWebFetches ?? 0) > 0 && ctx.fetchesUsed < ctx.budgets.maxFetches;
    if (
      (ctx.searchesUsed >= ctx.budgets.maxSearches && !pendingFetchHeadroom) ||
      ctx.fetchesUsed >= ctx.budgets.maxFetches ||
      !canDispatchAnyAction(
        {
          gatherActionsUsed: ctx.gatherActionsUsed ?? 0,
          ...(ctx.laneActionsUsed === undefined ? {} : { laneActionsUsed: ctx.laneActionsUsed }),
          searchesUsed: ctx.searchesUsed,
          ...(ctx.pendingWebFetches === undefined ? {} : { pendingWebFetches: ctx.pendingWebFetches }),
          fetchesUsed: ctx.fetchesUsed,
          admissibleLanes: ['web'],
        },
        {
          maxSearches: ctx.budgets.maxSearches,
          maxGatherActions: envelope,
          laneCaps: caps,
          maxFetches: ctx.budgets.maxFetches,
        },
      )
    ) {
      return { stop: true, reason: 'budget_exhausted' };
    }
  }
  if (ctx.growthLastTwoRounds[0] === 0 && ctx.growthLastTwoRounds[1] === 0) {
    return { stop: true, reason: 'no_progress' };
  }
  if (ctx.remainingNextQueries.length === 0) return { stop: true, reason: 'no_queries' };
  return { stop: false, reason: ctx.evaluatorRequestedContinue ? 'continue' : 'evaluator_stop_advisory' };
}

export interface SemanticGrowth {
  growthCount: number;
  growthEvidence: AgentEvidence[];
  conflictEvidence: AgentEvidence[];
}

/**
 * Semantic evidence growth (Phase 2 stall sensor): a round item counts as
 * growth only when it is admitted, fingerprint-distinct from ALL prior
 * evidence (isNearDuplicate), and does real work — covers an open required
 * question, adds an independent corroboration fingerprint for a covered
 * question, or sits in a detected conflict pair. Chunk-only additions
 * (already-covered question, duplicate fingerprint) score 0.
 */
export function semanticGrowth(
  roundEvidence: AgentEvidence[],
  priorEvidence: AgentEvidence[],
  openRequiredQuestionIds: string[],
): SemanticGrowth {
  const open = new Set(openRequiredQuestionIds);
  const priorFingerprintsByQuestion = new Map<string, Set<string>>();
  for (const prior of priorEvidence) {
    for (const qid of prior.questionIds) {
      let set = priorFingerprintsByQuestion.get(qid);
      if (!set) {
        set = new Set<string>();
        priorFingerprintsByQuestion.set(qid, set);
      }
      set.add(prior.corroboratingFingerprint);
    }
  }
  const conflicts = detectConflicts([...priorEvidence, ...roundEvidence]);
  const conflictedIds = new Set<string>();
  for (const conflict of conflicts) {
    conflictedIds.add(conflict.conflictBetween[0]);
    conflictedIds.add(conflict.conflictBetween[1]);
  }
  const growthEvidence = roundEvidence.filter((item) => {
    if (item.status !== 'admitted') return false;
    if (priorEvidence.some((prior) => isNearDuplicate(item, prior))) return false;
    if (item.questionIds.some((qid) => open.has(qid))) return true;
    if (
      item.questionIds.some(
        (qid) =>
          priorFingerprintsByQuestion.has(qid) &&
          !priorFingerprintsByQuestion.get(qid)?.has(item.corroboratingFingerprint),
      )
    ) {
      return true;
    }
    return conflictedIds.has(item.id);
  });
  const conflictEvidence = growthEvidence.filter((item) => conflictedIds.has(item.id));
  return { growthCount: growthEvidence.length, growthEvidence, conflictEvidence };
}

export interface EvidenceConflict {
  conflictBetween: [string, string];
  questionId: string;
  values: [string, string];
}

/** Numbers (with optional %), currency-adjacent numbers, and unit words after numbers. */
const VALUE_TOKEN_PATTERNS = [
  /\d[\d.,]*%?/g,
  /[$€£]\s?\d[\d.,]*%?/g,
  /\d[\d.,]*%?\s*(per month|per year|mo\b|yr\b|users|requests|credits|TB\b|GB\b|MB\b)/gi,
];

function extractValueTokens(excerpt: string): Set<string> {
  const tokens = new Set<string>();
  for (const pattern of VALUE_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of excerpt.matchAll(pattern)) {
      tokens.add(match[0].replace(/\s+/g, '').toLowerCase());
    }
  }
  return tokens;
}

function setsDisjoint(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) if (b.has(item)) return false;
  return true;
}

/**
 * Pure conflict scan: group admitted evidence by each shared questionId; two
 * items for the SAME question with non-empty DISJOINT value-token sets form a
 * conflict entry (first pair per questionId, array order). Capped at 8.
 *
 * Load-bearing limits (advisory only — never auto-adjudication): misses
 * contradictions that share value tokens across slots (e.g. "$99 + 500 credits"
 * vs "$199 + 500 credits" overlap on "500"/"500credits" so the disjoint-sets
 * rule never fires), misses non-numeric contradictions (no value tokens to
 * compare), and can flag compatible distinct dimensions as conflicts when two
 * items for one question carry different numbers that are not contradictory.
 * Consumers must treat conflicts as advisory signals for follow-up, never as
 * verdicts.
 */
export function detectConflicts(evidence: AgentEvidence[]): EvidenceConflict[] {
  const admitted = evidence.filter((item) => item.status === 'admitted');
  const byQuestion = new Map<string, AgentEvidence[]>();
  for (const item of admitted) {
    for (const qid of item.questionIds) {
      const group = byQuestion.get(qid);
      if (group) group.push(item);
      else byQuestion.set(qid, [item]);
    }
  }
  const conflicts: EvidenceConflict[] = [];
  for (const [questionId, group] of byQuestion) {
    if (conflicts.length >= MAX_CONFLICTS) break;
    const tokenSets = group.map((item) => extractValueTokens(item.excerpt));
    let found: EvidenceConflict | undefined;
    for (let i = 0; i < group.length && !found; i++) {
      const tokensI = tokenSets[i];
      const itemI = group[i];
      if (!tokensI || !itemI || tokensI.size === 0) continue;
      for (let j = i + 1; j < group.length; j++) {
        const tokensJ = tokenSets[j];
        const itemJ = group[j];
        if (!tokensJ || !itemJ || tokensJ.size === 0) continue;
        if (setsDisjoint(tokensI, tokensJ)) {
          const values: [string, string] = [
            [...tokensI][0] as string,
            [...tokensJ][0] as string,
          ];
          found = { conflictBetween: [itemI.id, itemJ.id], questionId, values };
          break;
        }
      }
    }
    if (found) conflicts.push(found);
  }
  return conflicts;
}

// Re-exported so planner/evaluator/consumers share one fingerprint source.
export { corroboratingFingerprint };

// --- Derived evidence confidence (Phase 9, eval-gated) ---

/** Per-fingerprint independence credit; at most two fingerprints count. */
const CONFIDENCE_PER_FINGERPRINT = 0.35;
const CONFIDENCE_MAX_FINGERPRINTS = 2;
/** Authority credit per distinct high-authority source class. */
const CONFIDENCE_PER_AUTHORITY_CLASS = 0.1;
const CONFIDENCE_MAX_SOURCE_CLASS_BOOST = 0.2;
/** Penalty per conflict pair touching the scored set. Uncapped; clamp handles. */
const CONFIDENCE_PER_CONFLICT = 0.15;
/** Credit per distinct verified fingerprint; verified ids map through fingerprints. */
const CONFIDENCE_PER_VERIFIED_FINGERPRINT = 0.15;
const CONFIDENCE_MAX_VERIFIED_BOOST = 0.3;

/** Source classes that raise authority: official docs, repos, academic venues. */
const AUTHORITY_SOURCE_CLASSES: ReadonlySet<string> = new Set(['official', 'repo', 'academic']);

export interface EvidenceConfidenceBreakdown {
  independentFingerprints: number;
  sourceClassBoost: number;
  conflictPenalty: number;
  verifiedBoost: number;
}

export interface EvidenceConfidence {
  score: number;
  breakdown: EvidenceConfidenceBreakdown;
}

/**
 * Derived confidence for an evidence group. Pure, deterministic, no model:
 * score = clamp01(independentFingerprints + sourceClassBoost +
 * conflictPenalty + verifiedBoost), where independentFingerprints is +0.35
 * per distinct corroboratingFingerprint among ADMITTED evidence (cap 2),
 * sourceClassBoost is +0.1 per distinct official/repo/academic class among
 * admitted evidence (cap +0.2), conflictPenalty is -0.15 per detectConflicts
 * pair (recomputed internally over the passed set) touching the set, and
 * verifiedBoost is +0.15 per distinct admitted fingerprint named by
 * verifiedEvidenceIds (cap +0.3; unknown ids ignored).
 *
 * Internal-only: AgentResultV1 unchanged. Intended for future public API +
 * synthesis ranking once it clears its ablation gate ( Revision 2 row 9:
 * no mechanism ships on vibes). Non-admitted evidence never contributes.
 */
export function deriveEvidenceConfidence(
  evidence: AgentEvidence[],
  verifiedEvidenceIds: string[] = [],
): EvidenceConfidence {
  const admitted = evidence.filter((item) => item.status === 'admitted');
  const distinctFingerprints = new Set(admitted.map((item) => item.corroboratingFingerprint));
  const independentFingerprints =
    Math.min(distinctFingerprints.size, CONFIDENCE_MAX_FINGERPRINTS) * CONFIDENCE_PER_FINGERPRINT;
  const distinctAuthority = new Set(
    admitted
      .map((item) => item.sourceRef.sourceClass)
      .filter((sourceClass) => AUTHORITY_SOURCE_CLASSES.has(sourceClass)),
  );
  const sourceClassBoost = Math.min(
    distinctAuthority.size * CONFIDENCE_PER_AUTHORITY_CLASS,
    CONFIDENCE_MAX_SOURCE_CLASS_BOOST,
  );
  const conflicts = detectConflicts(evidence);
  const touching = conflicts.length;
  const conflictPenalty = touching === 0 ? 0 : -CONFIDENCE_PER_CONFLICT * touching;
  const byId = new Map(admitted.map((item) => [item.id, item]));
  const verifiedFingerprints = new Set<string>();
  for (const id of verifiedEvidenceIds) {
    const item = byId.get(id);
    if (item) verifiedFingerprints.add(item.corroboratingFingerprint);
  }
  const verifiedBoost = Math.min(
    verifiedFingerprints.size * CONFIDENCE_PER_VERIFIED_FINGERPRINT,
    CONFIDENCE_MAX_VERIFIED_BOOST,
  );
  const raw = independentFingerprints + sourceClassBoost + conflictPenalty + verifiedBoost;
  const score = Math.min(1, Math.max(0, raw));
  return { score, breakdown: { independentFingerprints, sourceClassBoost, conflictPenalty, verifiedBoost } };
}
