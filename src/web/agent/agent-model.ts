// model proposes, code validates — this seam is the only model entry into the loop.
//
// createLeafModelClient drives completeJson over the LeafRuntimeProvider seam:
// one leaf call per completeJson (prompt already fenced/built by callers),
// JSON mode when the negotiated outputModes include 'json', else text-mode +
// client-side parse. Both paths end in client parse + wire-level gate, returning
// {ok,value} | {ok:false,reason} with fixed reasons only — never provider text.
// Callers (agent-core) validate domain-side; completeJson adds the wire gate only.
import type { LeafNegotiatedCapabilities, LeafRuntimeProvider } from './agent-rpc.js';
import { VERIFICATION_SCHEMA } from './agent-verifier.js';

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

/** Flat JSON-mode schema for the planner call: questions + scope notes. */
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
        },
      },
    },
    scopeNotes: { type: 'array', items: { type: 'string' } },
  },
};

/** Flat JSON-mode schema for the evaluator call. */
export const AGENT_EVALUATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['questionUpdates', 'nextQueries', 'shouldContinue'],
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
    nextQueries: { type: 'array', items: { type: 'string' } },
    shouldContinue: { type: 'boolean' },
  },
};

/** Flat JSON-mode schema for the synthesis IR call. */
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

/** Default per-call timeout: 60s. Overridable per call via opts. */
export const AGENT_MODEL_DEFAULT_TIMEOUT_MS = 60_000;

export interface LeafModelClientOptions {
  /** Explicit caps override the provider's negotiated view (tests, embeds). */
  outputModes?: readonly string[];
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
        Array.isArray(value.questionUpdates) && Array.isArray(value.nextQueries) && typeof value.shouldContinue === 'boolean'
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
      const negotiated = provider.getNegotiatedCapabilities?.();
      const outputModes = options?.outputModes ?? negotiated?.outputModes;
      const correlationV2 = options?.correlationV2 ?? negotiated?.correlationV2;
      const jsonMode = outputModes?.includes('json') ?? false;
      const maxOutputTokens = opts?.maxOutputTokens ?? entry.maxOutputTokens;
      const timeoutMs = opts?.timeoutMs ?? options?.timeoutMs ?? AGENT_MODEL_DEFAULT_TIMEOUT_MS;
      let text: string;
      try {
        const out = await provider.runLeaf(prompt, {
          timeoutMs,
          maxOutputTokens,
          role: correlationV2 !== undefined ? entry.v2Role : 'researcher',
          stage: entry.stage,
          ...(jsonMode ? { outputSchema: entry.schema } : {}),
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
