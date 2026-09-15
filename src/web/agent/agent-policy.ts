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
} as const;

/** Hard ceilings: resolveBudgets rejects past these, never clamps. */
export const MAX_ROUNDS = 6;
export const MAX_SEARCHES = 12;
export const MAX_FETCHES = 24;
export const MAX_UTILITY_CALLS = 16;
/** Cap on conflict entries per detectConflicts call. */
export const MAX_CONFLICTS = 8;

export interface AgentBudgets {
  maxRounds: number;
  maxSearches: number;
  maxFetches: number;
  maxUtilityCalls: number;
  deadlineMs?: number;
}

/**
 * Fill defaults and validate. Reject-not-clamp: any violation throws
 * RangeError with an exact message (house style: agent-contract budgets).
 */
export function resolveBudgets(partial?: Partial<AgentBudgets>): AgentBudgets {
  const merged: AgentBudgets = {
    maxRounds: partial?.maxRounds ?? AGENT_DEFAULT_BUDGETS.maxRounds,
    maxSearches: partial?.maxSearches ?? AGENT_DEFAULT_BUDGETS.maxSearches,
    maxFetches: partial?.maxFetches ?? AGENT_DEFAULT_BUDGETS.maxFetches,
    maxUtilityCalls: partial?.maxUtilityCalls ?? AGENT_DEFAULT_BUDGETS.maxUtilityCalls,
    ...(partial?.deadlineMs === undefined ? {} : { deadlineMs: partial.deadlineMs }),
  };
  const checkPositiveInt = (name: 'maxRounds' | 'maxSearches' | 'maxFetches' | 'maxUtilityCalls', value: number): void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  };
  checkPositiveInt('maxRounds', merged.maxRounds);
  checkPositiveInt('maxSearches', merged.maxSearches);
  checkPositiveInt('maxFetches', merged.maxFetches);
  checkPositiveInt('maxUtilityCalls', merged.maxUtilityCalls);
  if (merged.maxRounds > MAX_ROUNDS) throw new RangeError(`maxRounds exceeds maximum of ${MAX_ROUNDS}`);
  if (merged.maxSearches > MAX_SEARCHES) throw new RangeError(`maxSearches exceeds maximum of ${MAX_SEARCHES}`);
  if (merged.maxFetches > MAX_FETCHES) throw new RangeError(`maxFetches exceeds maximum of ${MAX_FETCHES}`);
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
}

// Load-bearing: the evaluator's shouldContinue is advisory only. It can keep
// a finished-looking loop going, but it can never stop one while required
// questions are ungrounded and budget remains — rules 2–6 run before the
// fallback, so code (not the model) declares victory.
export function stopPolicy(ctx: StopPolicyContext): { stop: boolean; reason: StopReason } {
  if (ctx.deadlineMs !== undefined && ctx.clockMs >= ctx.deadlineMs) return { stop: true, reason: 'deadline' };
  if (ctx.allRequiredGrounded) return { stop: true, reason: 'all_required_grounded' };
  if (ctx.roundsCompleted >= ctx.budgets.maxRounds) return { stop: true, reason: 'round_cap' };
  if (
    ctx.searchesUsed >= ctx.budgets.maxSearches ||
    ctx.fetchesUsed >= ctx.budgets.maxFetches ||
    ctx.utilityCallsUsed >= ctx.budgets.maxUtilityCalls
  ) {
    return { stop: true, reason: 'budget_exhausted' };
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
