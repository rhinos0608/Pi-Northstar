import { questionId } from './agent-state.js';
import { formatCandidatesSection, type AgentCandidate } from './agent-candidates.js';
import { normalizeUrl } from '../../search/fusion.js';
import { truncateUtf8Bytes } from './agent-report-route.js';
import { cleanUntrustedText } from '../../core/untrusted-content.js';
import { validateGatherIntent, type GatherIntent } from './agent-gather-intents.js';

export interface AgentPlanQuestion {
  id: string;
  question: string;
  priority: number;
  required: boolean;
  /** Validated per-question gather intent (planner-proposed route/action).
   *  Absent when the planner omitted it or it failed validation. Real ids
   *  attach post-normalize in applyPlanRoutes (core), preserving index
   *  alignment — the planner never emits questionIds. */
  intent?: GatherIntent;
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

/** Allowlist gate: a web_fetch url is servable only when its normalized form
 *  matches a bounded research-source candidate url. Model-generated urls without
 *  candidate provenance never validate. */
export function isResearchSourceCandidateUrl(url: string, candidates: readonly AgentCandidate[]): boolean {
  const want = normalizeUrl(url);
  return candidates.some((c) => c.kind === 'research-source' && normalizeUrl(c.url) === want);
}

export function normalizePlan(raw: unknown, candidates: readonly AgentCandidate[] = []): NormalizePlanResult {
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
    // Planner must NOT emit questionId: ids are code-owned (recomputed above).
    // A caller-supplied id/questionId is dropped with a warning, never trusted.
    if (rec.id !== undefined || rec.questionId !== undefined) {
      issues.push(`plan.questions[${i}].questionId ignored; ids are code-owned`);
    }
    // Nested gather intent: validated via the domain validator; invalid →
    // dropped with a warning, question text still stands.
    let intent: GatherIntent | undefined;
    if (rec.intent !== undefined) {
      const validated = validateGatherIntent(rec.intent);
      if (validated.ok) {
        if (validated.value.kind === 'web_fetch' && !isResearchSourceCandidateUrl(validated.value.url, candidates)) {
          issues.push(`plan.questions[${i}].intent dropped (web_fetch url not a research-source candidate)`);
        } else {
          intent = validated.value;
        }
      } else {
        issues.push(`plan.questions[${i}].intent dropped (${validated.reason})`);
      }
    }
    questions.push({
      id,
      question: q,
      priority: coercePriority(rec.priority, issues),
      required: coerceRequired(rec.required),
      ...(intent === undefined ? {} : { intent }),
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
  candidates: readonly AgentCandidate[] = [],
): string {
  // Wave 2 (D6): bounded candidates (most-recent ≤12) so round-N+1 intents
  // compile from candidate identity in the same refinement cycle. Navigation
  // hints only — never groundable; the planner emits intents, never evidence.
  const candidateLines = formatCandidatesSection(candidates);
  return [
    'You are the research planner. Decompose the goal into answerable research questions.',
    `Goal: ${sanitizeGoal(goal)}`,
    `Budget: maxRounds=${budget.maxRounds} maxSearches=${budget.maxSearches}`,
    ...(candidateLines.length === 0
      ? []
      : [
          'CANDIDATES',
          'navigation hints only — cannot satisfy or ground questions',
          ...candidateLines,
          'You may compile question intents from candidate identity: github files {scope:"files",query:path,repoHint:"owner/repo"} from github-code, issues listing from github-repo/github-issue, fetch from a research-source url, kg_lookup {entityType,id} from kg-entity.',
        ]),
    'Return JSON only, matching shape {"questions":[{"question":string,"priority":1|2|3,"required":boolean,"intent":{gather action}}],"scopeNotes":string[]}.',
    'Each question carries an "intent" naming its gather route/action: {"kind":"web_search","query":string} | {"kind":"research_search","query":string,"source"?:string,"yearFrom"?:number,"yearTo"?:number} | {"kind":"web_fetch","url":string} (direct read of a bounded research-source candidate url only — normalized match required, fetch reserve, never maxSearches) | {"kind":"github_search","scope":"repo|code","query":string,"repoHint"?:string} | {"kind":"github_search","scope":"issues","repoHint":string,"state"?:"open|closed|all","labels"?:string[],"number"?:number} (no query field — bounded listing filter) | {"kind":"github_search","scope":"files","query":string(path-like),"repoHint":string} | {"kind":"kg_lookup","entityType":"Person|Organization","name"?:string,"url"?:string,"id"?:string,"limit"?:number} (at least one of name/url/id; never a free-text query). Omit "intent" to default to web_search. Never emit questionId — ids are assigned by the controller. (Wave 9/D4: video/social lanes have no executor tool surface, so they are not offered here; the intent validator still accepts those kinds for back-compat, but the snapshot degrades them to web.)',
    'For github_search, repoHint belongs to the code scope (optional) and the files scope (required); the repo scope takes no repo selector; the issues scope is a bounded listing filter (repoHint required, optional state/labels/number, never a query — free-text issue search is not offered). Files scope requires a path-like query plus repoHint.',
    'Ask 2-5 answerable questions covering the goal\'s distinct dimensions.',
    'Constraints:',
    '- no questions requiring live data beyond search/fetch',
    '- web_fetch only for a bounded research-source candidate url (normalized match); never invent urls',
    '- each question self-contained',
    '- value-seeking phrasing',
  ].join('\n');
}
