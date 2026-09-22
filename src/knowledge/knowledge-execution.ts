import { resolveDiffbotSpend, type DiffbotSpend } from '../diffbot/diffbot-transport.js';
import { dedupeKgEntities, groupKgEntitiesByIdentity, partitionEnhanceClaims, rrfRankKgEntities } from './knowledge-aggregate.js';
import {
  buildKnowledgeResult,
  type KgAction, type KgAlignedGroup, type KgClaim, type KgEntity, type KgEntityEvidence,
  type KgError, type KgPartition, type KgResult, type KgSourceOutcome,
} from './knowledge-contract.js';
import { planExplicitProviders, runKgAuto, runKgFanout, selectAutoProviders } from './knowledge-domain.js';
import type { KgIdentitySignals } from './knowledge-normalize.js';

export interface KgRouting { outcomes: KgSourceOutcome[]; providers: string[]; attempted: string[]; }
export function resolveKgSpend(env: Record<string, string | undefined>): DiffbotSpend { return resolveDiffbotSpend(env); }

/** Shared provider selection/fanout. Caller owns provider adapter execution. */
export async function runKgProviderPlan(action: KgAction, requested: readonly string[] | undefined, configured: readonly string[], maxProviders: number, execute: (provider: string) => Promise<KgSourceOutcome>): Promise<KgRouting> {
  if (requested !== undefined) {
    const plan = planExplicitProviders(action, requested, { configured, maxProviders });
    const ran = await runKgFanout(execute, plan.runnable);
    return { outcomes: [...ran, ...plan.unsupported.map((error) => ({ provider: error.provider ?? 'unknown', entities: [], invalid: 0, error: { code: error.code, message: error.message, retryable: error.retryable, provider: error.provider ?? 'unknown' } as KgError }))], providers: [...requested], attempted: [...plan.runnable] };
  }
  const ordered = selectAutoProviders(action, configured);
  const { outcome, attempted } = await runKgAuto(execute, ordered);
  return { outcomes: [outcome], providers: [...attempted], attempted };
}

export function assembleKgSearchResult(input: { query: string; outcomes: readonly KgSourceOutcome[]; providers: readonly string[]; limit: number; pagination: { supported: boolean; hasMore: boolean; nextCursor?: string } }): { entities: KgEntity[]; envelope: KgResult } {
  // Apply final global limit (cap merged entities to caller limit) so adding second provider cannot exceed limit.
  const entities = rrfRankKgEntities(input.outcomes.map((outcome) => [...(outcome.entities ?? [])]))
    .map((entry) => entry.item)
    .slice(0, input.limit);
  return { entities, envelope: buildKnowledgeResult({ request: { tool: 'kg', action: 'search', providers: [...input.providers] }, outcomes: [...input.outcomes], data: { kind: 'search', entities }, pagination: { supported: input.pagination.supported, limit: input.limit, hasMore: input.pagination.hasMore, ...(input.pagination.nextCursor === undefined ? {} : { nextCursor: input.pagination.nextCursor }) } }) };
}

type KgEnhanceOutcome = KgSourceOutcome & { signals?: KgIdentitySignals[]; claims?: KgClaim[]; evidence?: KgEntityEvidence[] };
export interface KgEnhanceAssembly { entities: KgEntity[]; claims: KgClaim[]; conflicts: KgClaim[]; partitions: KgPartition[]; groups: KgAlignedGroup[]; evidence: KgEntityEvidence[]; }
function partition(outcome: KgSourceOutcome): KgPartition {
  const count = outcome.entities?.length ?? 0;
  if (outcome.error !== undefined) return { provider: outcome.provider, status: 'error', error: { ...outcome.error, provider: outcome.provider } };
  if ((outcome.invalid ?? 0) > 0) return { provider: outcome.provider, status: count > 0 ? 'partial' : 'error' };
  return { provider: outcome.provider, status: count > 0 ? 'ok' : 'empty' };
}

/** Shared enhance dedupe, identity alignment, claims/conflicts, groups, evidence assembly. */
export function assembleKgEnhanceResult(outcomes: readonly KgSourceOutcome[], opts: { maxEntities?: number } = {}): KgEnhanceAssembly {
  const enhanced = outcomes as readonly KgEnhanceOutcome[];
  const inputs = enhanced.flatMap((outcome) => (outcome.entities ?? []).map((entity, index) => ({ entity, provider: outcome.provider, ...(outcome.signals?.[index] === undefined ? {} : { signals: outcome.signals[index] }) })));
  const dedupedEntities = dedupeKgEntities(inputs).map((member) => member.entity);
  // Apply the caller's final global cap after provider fanout/dedupe. Sibling
  // enhance fields must obey the same visible entity set: otherwise groups,
  // claims, or evidence could leak entities beyond maxEntities.
  const capped = typeof opts.maxEntities === 'number' && opts.maxEntities > 0;
  const entities = capped ? dedupedEntities.slice(0, opts.maxEntities) : dedupedEntities;
  const returnedEntityIds = new Set(entities.map((entity) => entity.id));

  const allInternalGroups = groupKgEntitiesByIdentity(inputs);
  const internalGroups = capped
    ? allInternalGroups.filter((group) => group.members.some((member) => returnedEntityIds.has(member.entity.id)))
    : allInternalGroups;
  const visibleMemberIds = new Set(
    internalGroups.flatMap((group) => group.members.map((member) => member.entity.id)),
  );

  const publicIdByKey = new Map<string, string>();
  internalGroups.forEach((group, index) => publicIdByKey.set(group.key, `alignment:${index + 1}`));
  const groups = internalGroups.map((group): KgAlignedGroup => ({ id: publicIdByKey.get(group.key) ?? 'alignment:0', basis: group.basis, strength: group.strength, ...(group.alignmentConfidence === undefined ? {} : { alignmentConfidence: group.alignmentConfidence }), members: group.members.map((member) => ({ entity: member.entity, provider: member.provider })) }));
  const subjectToGroup = new Map<string, string>();
  for (const group of internalGroups) for (const member of group.members) { const publicId = publicIdByKey.get(group.key) ?? 'alignment:0'; if (!subjectToGroup.has(member.entity.id)) subjectToGroup.set(member.entity.id, publicId); }
  const allClaims = enhanced
    .flatMap((outcome) => (outcome.claims ?? []).map((claim) => claim.provider === undefined ? { ...claim, provider: outcome.provider } : claim))
    .filter((claim) => !capped || visibleMemberIds.has(claim.subjectId));
  const alignedClaims = allClaims.map((claim) => { const key = subjectToGroup.get(claim.subjectId); return key !== undefined && key !== claim.subjectId ? { ...claim, subjectId: key } : claim; });
  const { claims, conflicts } = partitionEnhanceClaims(alignedClaims);
  const seenEvidence = new Set<string>(); const evidence: KgEntityEvidence[] = [];
  for (const outcome of enhanced) for (const record of outcome.evidence ?? []) {
    if ((capped && !visibleMemberIds.has(record.entityId)) || seenEvidence.has(record.entityId)) continue;
    seenEvidence.add(record.entityId);
    evidence.push(record);
  }
  return { entities, claims, conflicts, partitions: outcomes.map(partition), groups, evidence };
}
