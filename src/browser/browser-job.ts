import { parseLoopbackDebugTarget } from './loopback-debug-policy.js';
import type { BrowserAction, BrowserRequest } from './browser-policy.js';

// ── Types ──

export type JobStepKind = 'open' | 'click' | 'fill' | 'type' | 'select' | 'wait' | 'assert' | 'snapshot' | 'screenshot';

export interface JobStep {
  kind: JobStepKind;
  url?: string;
  selector?: string;
  text?: string;
  values?: string[];
  waitMs?: number;
  assertText?: string;
  continueOnFailure?: boolean;
}

export interface JobRequest {
  steps: JobStep[];
  maxSteps?: number;
}

const VALID_STEP_KINDS: readonly JobStepKind[] = [
  'open', 'click', 'fill', 'type', 'select', 'wait', 'assert', 'snapshot', 'screenshot',
];

const MAX_STEPS_DEFAULT = 20;

/** Validate a raw job request, throwing on invalid shape. */
export function validateJobRequest(raw: Record<string, unknown>): JobRequest {
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('steps is required and must be a non-empty array');
  }

  const callerMax = typeof raw.maxSteps === 'number' ? raw.maxSteps : MAX_STEPS_DEFAULT;
  // Hard cap: caller may not exceed the built-in constant
  const maxSteps = Math.min(callerMax, MAX_STEPS_DEFAULT);
  if (raw.steps.length > maxSteps) {
    throw new Error(`too many steps (max ${maxSteps})`);
  }

  const steps: JobStep[] = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const s = raw.steps[i] as Record<string, unknown>;
    if (typeof s !== 'object' || s === null) {
      throw new Error(`step ${i}: must be an object`);
    }
    const kind = s.kind;
    if (typeof kind !== 'string' || !(VALID_STEP_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`step ${i}: unknown kind "${String(kind)}"`);
    }

    const step: JobStep = { kind: kind as JobStepKind };

    if (kind === 'open') {
      if (typeof s.url !== 'string' || !s.url) throw new Error(`step ${i}: open requires url`);
      step.url = s.url;
    }
    if (kind === 'click' || kind === 'fill' || kind === 'type' || kind === 'select' || kind === 'assert') {
      if (typeof s.selector !== 'string' || !s.selector) throw new Error(`step ${i}: ${kind} requires selector`);
      step.selector = s.selector;
    }
    if (kind === 'fill' || kind === 'type') {
      if (typeof s.text !== 'string') throw new Error(`step ${i}: ${kind} requires text`);
      step.text = s.text;
    }
    if (kind === 'select') {
      if (!Array.isArray(s.values)) throw new Error(`step ${i}: select requires values array`);
      step.values = s.values.filter((v): v is string => typeof v === 'string');
      if (step.values.length === 0) throw new Error(`step ${i}: select requires a non-empty values array`);
    }
    if (kind === 'wait' && typeof s.waitMs === 'number') {
      step.waitMs = s.waitMs;
    }
    if (kind === 'assert' && typeof s.assertText === 'string') {
      step.assertText = s.assertText;
    }
    if (s.continueOnFailure === true) {
      step.continueOnFailure = true;
    }

    steps.push(step);
  }

  validateNoLoopbackInJob(steps);

  return { steps, maxSteps };
}

/** Reject job steps with loopback URLs in open-step URLs (mirrors batch policy). */
export function validateNoLoopbackInJob(steps: JobStep[]): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === 'open') {
      const url = step.url;
      if (typeof url === 'string') {
        if (url.includes('@')) {
          throw new Error(
            `step ${i}: URL with credentials is not allowed in job steps.`,
          );
        }
        if (parseLoopbackDebugTarget(url)) {
          throw new Error(
            `step ${i}: loopback URL '${url}' is not allowed in job steps. Use a single navigate action instead.`,
          );
        }
      }
    }
  }
}

/** Map a JobStep to a BrowserRequest for the adapter's execute() method. */
export function jobStepToBrowserRequest(step: JobStep): BrowserRequest {
  // Map non-BrowserAction kinds to valid actions
  let action: BrowserAction;
  if (step.kind === 'open') {
    action = 'navigate';
  } else if (step.kind === 'assert') {
    // Post-condition: page must contain assertText (CLI substring match).
    // Selector stays for pre-wait scoping when both are present.
    action = 'wait';
  } else {
    action = step.kind as BrowserAction;
  }

  const req: BrowserRequest = { action };

  if (step.url) req.url = step.url;
  if (step.selector) req.selector = step.selector;
  if (step.text) req.text = step.text;
  if (step.waitMs !== undefined) req.waitMs = step.waitMs;
  if (step.kind === 'select' && step.values) req.values = step.values;
  if (step.kind === 'assert' && step.assertText) req.text = step.assertText;

  return req;
}
