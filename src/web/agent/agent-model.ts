// model proposes, code validates — this seam is the only model entry into the loop.
//
// createLeafModelClient drives completeJson over the LeafRuntimeProvider seam:
// one leaf call per completeJson (prompt already fenced/built by callers).
// Wire schemas attach only when the negotiated jsonSchema dialect is
// 'structured-v1'; otherwise text-mode + client-side parse (outputModes 'json'
// alone is insufficient). Both paths end in client parse + wire-level gate,
// returning {ok,value} | {ok:false,reason} with fixed reasons only — never
// provider text.
// Callers (agent-core) validate domain-side; completeJson adds the wire gate only.
import type { LeafNegotiatedCapabilities, LeafRuntimeProvider } from './agent-rpc.js';
import { VERIFICATION_SCHEMA } from './agent-verifier.js';
import { buildPlannerPrompt } from './agent-planner.js';
import { formatCapabilitiesForPrompt, type EffectiveCapabilitiesSnapshot } from './agent-capabilities.js';
import type { AgentBudgets } from './agent-policy.js';

export interface AgentModelRequest {
  prompt: string;
  schemaName: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface AgentModelClient {
  completeJson<T>(
    prompt: string,
    schemaName: string,
    opts?: { timeoutMs?: number; maxOutputTokens?: number },
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }>;
}

/**
 * Wire-level GatherIntent shape: kind enum + optional per-kind fields,
 * additionalProperties false. Deliberately oneOf-free (oneOf is outside the
 * negotiated structured-v1 subset); the domain validator
 * (validateGatherIntent, exact-keys per kind) is authoritative. The wire
 * gate (wireValidates below) checks array presence only.
 */
export const GATHER_INTENT_WIRE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['web_search', 'research_search', 'web_fetch', 'github_search', 'social_search', 'video_transcript', 'kg_lookup'] },
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    source: { type: 'string' },
    yearFrom: { type: 'integer', minimum: 1900, maximum: 2100 },
    yearTo: { type: 'integer', minimum: 1900, maximum: 2100 },
    scope: { type: 'string', enum: ['repo', 'code', 'issues', 'files'] },
    repoHint: { type: 'string' },
    state: { type: 'string', enum: ['open', 'closed', 'all'] },
    labels: { type: 'array', items: { type: 'string' } },
    number: { type: 'integer', minimum: 1 },
    platform: { type: 'string' },
    sort: { type: 'string' },
    videoHint: { type: 'string' },
    entityType: { type: 'string', enum: ['Person', 'Organization'] },
    name: { type: 'string' },
    url: { type: 'string' },
    id: { type: 'string' },
  },
  additionalProperties: false,
};

/**
 * Planner schema (questions + scope notes + nested per-question gather
 * intent). Forwarded on the wire only when the negotiated jsonSchema dialect
 * is 'structured-v1'; otherwise the call runs as text JSON with client-side
 * parse + wire gate. The wire `intent` shape is intentionally permissive
 * (kind enum + optional fields, no oneOf — outside the structured-v1 subset);
 * the DOMAIN validator (validateGatherIntent) is authoritative.
 */
export const AGENT_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question'],
        properties: {
          question: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
          required: { type: 'boolean' },
          intent: GATHER_INTENT_WIRE_SCHEMA,
        },
      },
    },
    scopeNotes: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Evaluator schema (clean break: nextQueries deleted, no old-name alias).
 * Forwarded on the wire only when the negotiated jsonSchema dialect is
 * 'structured-v1'; otherwise text JSON with client-side parse + wire gate.
 * nextActions carry questionId (evaluation prompts include established IDs).
 */
export const AGENT_EVALUATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['questionUpdates', 'nextActions', 'shouldContinue'],
  properties: {
    questionUpdates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId', 'status'],
        properties: {
          questionId: { type: 'string' },
          status: { type: 'string', enum: ['answered', 'blocked', 'abandoned'] },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
    nextActions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId', 'intent'],
        properties: {
          questionId: { type: 'string' },
          intent: GATHER_INTENT_WIRE_SCHEMA,
        },
      },
    },
    shouldContinue: { type: 'boolean' },
  },
};

/**
 * Synthesis IR schema. Forwarded on the wire only when the negotiated
 * jsonSchema dialect is 'structured-v1'; otherwise text JSON with
 * client-side parse + wire gate.
 */
export const AGENT_SYNTHESIS_IR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['blocks', 'claimUnits'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sectionId', 'prose', 'claimUnitIds'],
        properties: {
          sectionId: { type: 'string' },
          prose: { type: 'string' },
          claimUnitIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    claimUnits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'evidenceIds'],
        properties: {
          text: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    unresolvedGaps: { type: 'array', items: { type: 'string' } },
  },
};

type ModelCallRole = 'planner' | 'evaluator' | 'synthesis' | 'verification';

interface SchemaEntry {
  schema: Record<string, unknown>;
  role: ModelCallRole;
  stage: string;
  /** Correlation v2 role handle (Pi-Atlas-owned vocabulary). */
  v2Role: string;
  maxOutputTokens: number;
}

const SCHEMA_REGISTRY: Record<string, SchemaEntry> = {
  plan: { schema: AGENT_PLAN_SCHEMA, role: 'planner', stage: 'agent-plan', v2Role: 'coverage_planner', maxOutputTokens: 2048 },
  'agent-plan': { schema: AGENT_PLAN_SCHEMA, role: 'planner', stage: 'agent-plan', v2Role: 'coverage_planner', maxOutputTokens: 2048 },
  evaluation: { schema: AGENT_EVALUATION_SCHEMA, role: 'evaluator', stage: 'agent-evaluate', v2Role: 'researcher', maxOutputTokens: 2048 },
  eval: { schema: AGENT_EVALUATION_SCHEMA, role: 'evaluator', stage: 'agent-evaluate', v2Role: 'researcher', maxOutputTokens: 2048 },
  'agent-evaluation': { schema: AGENT_EVALUATION_SCHEMA, role: 'evaluator', stage: 'agent-evaluate', v2Role: 'researcher', maxOutputTokens: 2048 },
  synthesis: { schema: AGENT_SYNTHESIS_IR_SCHEMA, role: 'synthesis', stage: 'agent-synthesize', v2Role: 'synthesizer', maxOutputTokens: 4096 },
  'synthesis-ir': { schema: AGENT_SYNTHESIS_IR_SCHEMA, role: 'synthesis', stage: 'agent-synthesize', v2Role: 'synthesizer', maxOutputTokens: 4096 },
  'agent-synthesis-ir': { schema: AGENT_SYNTHESIS_IR_SCHEMA, role: 'synthesis', stage: 'agent-synthesize', v2Role: 'synthesizer', maxOutputTokens: 4096 },
  verification: { schema: VERIFICATION_SCHEMA, role: 'verification', stage: 'agent-verify', v2Role: 'researcher', maxOutputTokens: 2048 },
};

/**
 * Steering seams over one leaf provider (Task 4, text-JSON mode).
 *
 * Shapes mirror AgentCoreDeps exactly: planner takes (goal, budgets) and
 * builds the same prompt runAgentCore's utility path would (buildPlannerPrompt
 * + Capabilities block when a snapshot is supplied); evaluator/synthesizer/
 * verifier/repairer take the core-built ({ prompt }) and return the raw model
 * value. completeJson owns the wire gate + text-JSON fallback; failures
 * degrade to undefined (core maps that to its deterministic fallbacks) and
 * never throw or leak provider text. Repairer reuses the synthesis schema.
 */
export interface AgentModelSeams {
  planner: (goal: string, budgets: AgentBudgets) => Promise<unknown>;
  evaluator: (args: { prompt: string }) => Promise<unknown>;
  synthesizer: (args: { prompt: string }) => Promise<unknown>;
  verifier: (args: { prompt: string }) => Promise<unknown>;
  repairer: (args: { prompt: string }) => Promise<unknown>;
  utilityModelClient: AgentModelClient;
}

export function createAgentModelSeams(
  provider: LeafRuntimeProvider,
  opts?: { capabilitiesSnapshot?: EffectiveCapabilitiesSnapshot },
): AgentModelSeams {
  const client = createLeafModelClient(provider);
  const callRole = async (prompt: string, schemaName: string): Promise<unknown> => {
    let outcome: { ok: true; value: unknown } | { ok: false; reason: string };
    try {
      outcome = await client.completeJson<unknown>(prompt, schemaName);
    } catch {
      return undefined;
    }
    return outcome.ok ? outcome.value : undefined;
  };
  return {
    planner: async (goal, budgets) => {
      const base = buildPlannerPrompt(goal, budgets);
      const prompt =
        opts?.capabilitiesSnapshot === undefined
          ? base
          : `${base}\nCapabilities:\n${formatCapabilitiesForPrompt(opts.capabilitiesSnapshot)}`;
      return callRole(prompt, 'agent-plan');
    },
    evaluator: async ({ prompt }) => callRole(prompt, 'agent-evaluation'),
    synthesizer: async ({ prompt }) => callRole(prompt, 'synthesis'),
    verifier: async ({ prompt }) => callRole(prompt, 'verification'),
    repairer: async ({ prompt }) => callRole(prompt, 'synthesis'),
    utilityModelClient: client,
  };
}

/** Default per-call timeout: 60s. Overridable per call via opts. */
export const AGENT_MODEL_DEFAULT_TIMEOUT_MS = 60_000;

export interface LeafModelClientOptions {
  correlationV2?: LeafNegotiatedCapabilities['correlationV2'];
  timeoutMs?: number;
}

function safeLeafReason(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) return code;
  return 'provider_error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract JSON from text-mode output: fenced ```json blocks unwrapped, else raw. */
function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function wireValidates(entry: SchemaEntry, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (entry.role) {
    case 'planner':
      return Array.isArray(value.questions);
    case 'evaluator':
      return (
        Array.isArray(value.questionUpdates) && Array.isArray(value.nextActions) && typeof value.shouldContinue === 'boolean'
      );
    case 'synthesis':
      return Array.isArray(value.blocks) && Array.isArray(value.claimUnits);
    case 'verification': {
      if (!Array.isArray(value.clauseVerdicts) || typeof value.reason !== 'string') return false;
      return (value.clauseVerdicts as unknown[]).every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.clause === 'string' &&
          entry.clause.trim() !== '' &&
          (entry.verdict === 'supported' || entry.verdict === 'refuted' || entry.verdict === 'not_enough_evidence') &&
          (entry.reason === undefined || typeof entry.reason === 'string'),
      );
    }
  }
}

/**
 * Production AgentModelClient over a LeafRuntimeProvider. Resolves schema,
 * role tokens, correlation role, and json/text mode per call; parses client-side.
 */
export function createLeafModelClient(
  provider: LeafRuntimeProvider,
  options?: LeafModelClientOptions,
): AgentModelClient {
  return {
    async completeJson<T>(
      prompt: string,
      schemaName: string,
      opts?: { timeoutMs?: number; maxOutputTokens?: number },
    ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
      const entry = SCHEMA_REGISTRY[schemaName];
      if (entry === undefined) return { ok: false, reason: 'unknown_schema' };
      const negotiated = provider.getNegotiatedCapabilities?.() as
        | (LeafNegotiatedCapabilities & { jsonSchema?: unknown })
        | undefined;
      const rawDialect = negotiated?.jsonSchema;
      // Force-text guard: only the negotiated 'structured-v1' dialect earns a
      // wire schema. Absent, 'flat-v1', or anything else → text JSON with
      // client-side parse via extractJsonText + wireValidates below.
      const structuredJson = rawDialect === 'structured-v1';
      const correlationV2 = options?.correlationV2 ?? negotiated?.correlationV2;
      const maxOutputTokens = opts?.maxOutputTokens ?? entry.maxOutputTokens;
      const timeoutMs = opts?.timeoutMs ?? options?.timeoutMs ?? AGENT_MODEL_DEFAULT_TIMEOUT_MS;
      let text: string;
      try {
        const out = await provider.runLeaf(prompt, {
          timeoutMs,
          maxOutputTokens,
          role: correlationV2 !== undefined ? entry.v2Role : 'researcher',
          stage: entry.stage,
          ...(structuredJson ? { outputSchema: entry.schema } : {}),
        });
        if (typeof out?.text !== 'string' || out.text.trim() === '') return { ok: false, reason: 'schema_error' };
        text = out.text;
      } catch (error) {
        return { ok: false, reason: safeLeafReason(error) };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonText(text));
      } catch {
        return { ok: false, reason: 'schema_error' };
      }
      if (!wireValidates(entry, parsed)) return { ok: false, reason: 'schema_error' };
      return { ok: true, value: parsed as T };
    },
  };
}
