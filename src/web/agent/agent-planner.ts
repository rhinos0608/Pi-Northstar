import { questionId } from './agent-state.js';
import { truncateUtf8Bytes } from './agent-report-route.js';
import { cleanUntrustedText } from '../../core/untrusted-content.js';

export interface AgentPlanQuestion {
  id: string;
  question: string;
  priority: number;
  required: boolean;
}

export interface AgentPlan {
  questions: AgentPlanQuestion[];
  scopeNotes: string[];
}

export type NormalizePlanResult =
  | { ok: true; plan: AgentPlan; issues: string[] }
  | { ok: false; issues: string[] };

const MAX_QUESTIONS = 5;
const MIN_QUESTION_BYTES = 8;
const MAX_QUESTION_BYTES = 512;
const MAX_SCOPE_NOTES = 5;
const MAX_SCOPE_NOTE_BYTES = 512;
/** Max goal bytes embedded in planner prompt/fallback (truncate-not-reject; prompt stays single-line). */
export const MAX_GOAL_BYTES = 2048;

/** Fold a planner question to a single line: newline→space, strip control
 *  chars, collapse whitespace runs, trim. Byte checks run on this form. */
export function singleLineQuestion(question: string): string {
  return question
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clamp goal to MAX_GOAL_BYTES and collapse newlines to spaces so the Goal line stays single-line.
 *  cleanUntrustedText first (strip invisible/control formatting), then fold, then byte-cap on the final form. */
export function sanitizeGoal(goal: string): string {
  return truncateUtf8Bytes(cleanUntrustedText(goal).replace(/\r\n|\r|\n/g, ' '), MAX_GOAL_BYTES);
}

function coercePriority(raw: unknown, issues: string[]): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (typeof raw === 'undefined') return 2;
  if (!Number.isFinite(n)) {
    issues.push('question priority is not a number; defaulted to 2');
    return 2;
  }
  const clamped = Math.min(3, Math.max(1, Math.trunc(n)));
  if (clamped !== n) issues.push(`question priority ${String(raw)} out of range; clamped to ${clamped}`);
  return clamped;
}

function coerceRequired(raw: unknown): boolean {
  if (typeof raw === 'undefined') return true;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'false' || v === '0' || v === 'no') return false;
    if (v === 'true' || v === '1' || v === 'yes') return true;
  }
  return Boolean(raw);
}

export function normalizePlan(raw: unknown): NormalizePlanResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ['plan must be an object'] };
  }
  const issues: string[] = [];
  const record = raw as Record<string, unknown>;

  if (!Array.isArray(record.questions)) {
    return { ok: false, issues: ['plan.questions must be an array'] };
  }
  const entries = record.questions as unknown[];
  if (entries.length === 0) {
    return { ok: false, issues: ['plan.questions must have at least 1 entry'] };
  }
  const sliced = entries.length > MAX_QUESTIONS ? entries.slice(0, MAX_QUESTIONS) : entries;
  if (entries.length > MAX_QUESTIONS) issues.push('plan truncated to 5 questions');

  const questions: AgentPlanQuestion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sliced.length; i++) {
    const entry = sliced[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, issues: [`plan.questions[${i}] must be an object`] };
    }
    const rawQ = (entry as Record<string, unknown>).question;
    if (typeof rawQ !== 'string' || rawQ.trim() === '') {
      return { ok: false, issues: [`plan.questions[${i}].question must be a non-empty string`] };
    }
    // Defense in depth: single-line each question (newline→space, collapse runs,
    // strip control chars) before the byte check so embedded newlines cannot
    // smuggle multi-line prompts past consumers. Consumers also fence.
    const q = singleLineQuestion(rawQ);
    if (q === '') {
      return { ok: false, issues: [`plan.questions[${i}].question must be a non-empty string`] };
    }
    const bytes = Buffer.byteLength(q, 'utf8');
    if (bytes < MIN_QUESTION_BYTES || bytes > MAX_QUESTION_BYTES) {
      return { ok: false, issues: [`plan.questions[${i}].question must be 8..512 bytes; got ${bytes}`] };
    }
    // Caller id never trusted: recompute silently by overwriting.
    const id = questionId(q);
    if (seen.has(id)) {
      return { ok: false, issues: ['duplicate question'] };
    }
    seen.add(id);
    const rec = entry as Record<string, unknown>;
    questions.push({
      id,
      question: q,
      priority: coercePriority(rec.priority, issues),
      required: coerceRequired(rec.required),
    });
  }

  // Allowlist-construct: unknown top-level keys ignored; only questions + scopeNotes read.
  let scopeNotes: string[] = [];
  if (typeof record.scopeNotes !== 'undefined') {
    if (!Array.isArray(record.scopeNotes)) {
      return { ok: false, issues: ['plan.scopeNotes must be an array of strings'] };
    }
    for (let i = 0; i < record.scopeNotes.length; i++) {
      const note = (record.scopeNotes as unknown[])[i];
      if (typeof note !== 'string') {
        return { ok: false, issues: [`plan.scopeNotes[${i}] must be a string`] };
      }
      if (Buffer.byteLength(note, 'utf8') > MAX_SCOPE_NOTE_BYTES) {
        return { ok: false, issues: [`plan.scopeNotes[${i}] exceeds 512 bytes`] };
      }
    }
    scopeNotes = (record.scopeNotes as string[]).slice(0, MAX_SCOPE_NOTES);
  }

  return { ok: true, plan: { questions, scopeNotes }, issues };
}

export function fallbackPlan(goal: string): AgentPlan {
  const safe = sanitizeGoal(goal);
  return {
    questions: [{ id: questionId(safe), question: safe, priority: 3, required: true }],
    scopeNotes: ['planner fallback: root goal as single required question'],
  };
}

export function buildPlannerPrompt(
  goal: string,
  budget: { maxRounds: number; maxSearches: number },
): string {
  return [
    'You are the research planner. Decompose the goal into answerable research questions.',
    `Goal: ${sanitizeGoal(goal)}`,
    `Budget: maxRounds=${budget.maxRounds} maxSearches=${budget.maxSearches}`,
    'Return JSON only, matching shape {"questions":[{"question":string,"priority":1|2|3,"required":boolean}],"scopeNotes":string[]}.',
    'Ask 2-5 answerable questions covering the goal\'s distinct dimensions.',
    'Constraints:',
    '- no questions requiring live data beyond search/fetch',
    '- each question self-contained',
    '- value-seeking phrasing',
  ].join('\n');
}
