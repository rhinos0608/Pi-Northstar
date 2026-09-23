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

export const VALID_STEP_KINDS: readonly JobStepKind[] = [
  'open', 'click', 'fill', 'type', 'select', 'wait', 'assert', 'snapshot', 'screenshot',
];

export const MAX_STEPS_DEFAULT = 20;
export const MAX_JOB_STEPS = MAX_STEPS_DEFAULT;

const JOB_FIELDS = new Set(['steps', 'maxSteps']);
const JOB_STEP_FIELDS: Record<JobStepKind, ReadonlySet<string>> = {
  open: new Set(['kind', 'url', 'continueOnFailure']),
  click: new Set(['kind', 'selector', 'continueOnFailure']),
  fill: new Set(['kind', 'selector', 'text', 'continueOnFailure']),
  type: new Set(['kind', 'selector', 'text', 'continueOnFailure']),
  select: new Set(['kind', 'selector', 'values', 'continueOnFailure']),
  wait: new Set(['kind', 'selector', 'text', 'waitMs', 'continueOnFailure']),
  assert: new Set(['kind', 'selector', 'assertText', 'waitMs', 'continueOnFailure']),
  snapshot: new Set(['kind', 'continueOnFailure']),
  screenshot: new Set(['kind', 'continueOnFailure']),
};

/** Validate a raw job request, throwing on invalid shape. */
export function validateJobRequest(raw: Record<string, unknown>): JobRequest {
  for (const key of Object.keys(raw)) {
    if (!JOB_FIELDS.has(key)) throw new Error(`unknown job field: ${key}`);
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('steps is required and must be a non-empty array');
  }

  if (
    raw.maxSteps !== undefined &&
    (typeof raw.maxSteps !== 'number' || !Number.isInteger(raw.maxSteps) || raw.maxSteps < 1)
  ) {
    throw new Error('maxSteps must be a positive integer');
  }
  if (typeof raw.maxSteps === 'number' && raw.maxSteps > MAX_STEPS_DEFAULT) {
    throw new Error(`maxSteps must be an integer 1..${MAX_STEPS_DEFAULT}`);
  }
  const maxSteps = typeof raw.maxSteps === 'number' ? raw.maxSteps : MAX_STEPS_DEFAULT;
  if (raw.steps.length > maxSteps) {
    throw new Error(`too many steps (max ${maxSteps})`);
  }

  const steps: JobStep[] = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const rawStep = raw.steps[i];
    if (typeof rawStep !== 'object' || rawStep === null || Array.isArray(rawStep)) {
      throw new Error(`step ${i}: must be an object`);
    }
    const s = rawStep as Record<string, unknown>;
    const kind = s.kind;
    if (typeof kind !== 'string' || !(VALID_STEP_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`step ${i}: unknown kind`);
    }
    const stepKind = kind as JobStepKind;
    for (const key of Object.keys(s)) {
      if (!JOB_STEP_FIELDS[stepKind].has(key)) throw new Error(`step ${i}: field ${key} is not allowed for ${stepKind}`);
    }
    if (s.continueOnFailure !== undefined && typeof s.continueOnFailure !== 'boolean') {
      throw new Error(`step ${i}: continueOnFailure must be a boolean`);
    }

    const step: JobStep = { kind: stepKind };

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
      if (s.values.some((value) => typeof value !== 'string')) {
        throw new Error(`step ${i}: select values must all be strings`);
      }
      step.values = [...(s.values as string[])];
      if (step.values.length === 0) throw new Error(`step ${i}: select requires a non-empty values array`);
    }
    if (kind === 'wait') {
      if (s.selector !== undefined && typeof s.selector !== 'string') throw new Error(`step ${i}: wait selector must be a string`);
      if (s.text !== undefined && typeof s.text !== 'string') throw new Error(`step ${i}: wait text must be a string`);
      if (typeof s.selector === 'string') step.selector = s.selector;
      if (typeof s.text === 'string') step.text = s.text;
    }
    if ((kind === 'wait' || kind === 'assert') && s.waitMs !== undefined) {
      if (typeof s.waitMs !== 'number' || !Number.isFinite(s.waitMs)) throw new Error(`step ${i}: waitMs must be a finite number`);
      step.waitMs = s.waitMs;
    }
    if (kind === 'assert' && s.assertText !== undefined) {
      if (typeof s.assertText !== 'string') throw new Error(`step ${i}: assertText must be a string`);
      step.assertText = s.assertText;
    }
    if (s.continueOnFailure === true) step.continueOnFailure = true;

    steps.push(step);
  }

  validateNoLoopbackInJob(steps);

  return { steps, maxSteps };
}

function jobUrlHasCredentials(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

/** Reject job steps with loopback URLs in open-step URLs (mirrors batch policy). */
export function validateNoLoopbackInJob(steps: JobStep[]): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === 'open') {
      const url = step.url;
      if (typeof url === 'string') {
        if (jobUrlHasCredentials(url)) {
          throw new Error(
            `step ${i}: URL with credentials is not allowed in job steps.`,
          );
        }
        if (parseLoopbackDebugTarget(url)) {
          throw new Error(
            `step ${i}: loopback URL is not allowed in job steps. Use a single navigate action instead.`,
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
