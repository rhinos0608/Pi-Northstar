import type { AgentModelClient } from '../../../../src/web/agent/agent-model.js';

export interface ScriptedStep {
  match?: RegExp | string;
  value?: unknown;
  fail?: string;
}

export interface ModelCall {
  prompt: string;
  schemaName: string;
}

function deepClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createScriptedModel(steps: ScriptedStep[]): AgentModelClient & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  let cursor = 0;
  const client = {
    calls,
    async completeJson<T>(
      prompt: string,
      schemaName: string,
    ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
      calls.push({ prompt, schemaName });
      let index = steps.findIndex((step) => {
        if (step.match === undefined) return false;
        if (typeof step.match === 'string') return prompt.includes(step.match);
        return step.match.test(prompt);
      });
      if (index === -1) {
        index = Math.min(cursor, steps.length - 1);
        cursor += 1;
      }
      const step = steps[Math.max(0, index)];
      if (!step) return { ok: false, reason: 'no scripted steps' };
      if (typeof step.fail === 'string') return { ok: false, reason: step.fail };
      return { ok: true, value: deepClone(step.value) as T };
    },
  };
  return client;
}
