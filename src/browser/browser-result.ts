import type { BackendCallResult } from '../backend.js';
import type { BrowserAction } from './browser-policy.js';
import type { OverlayProbe } from './overlay-detection.js';

export type ResultCategory = 'success' | 'failure';

export type SuccessCategory =
  | 'inspection'          // read-only: text, html, get_url, get_title, snapshot, tabs, cookies, status
  | 'artifact-unverified' // screenshot captured but not written to a durable path yet
  | 'artifact-saved'      // screenshot/artifact persisted to a caller-visible path
  | 'completed';          // mutation succeeded: navigate, click, type, fill, scroll, wait, set_cookies, close

export type FailureCategory =
  | 'timeout'
  | 'missing-binary'
  | 'stale-ref'
  | 'no-active-page'
  | 'domain-blocked'
  | 'policy-denied'
  | 'dispatch-unverified'
  | 'overlay-blocked'
  | 'invalid-request'
  | 'process-error'
  | 'unknown';

export interface NextAction {
  tool: 'browser';
  args: Record<string, unknown>;
  reason: string;
}

export interface PageChangeSummary {
  mutationKind: 'navigation' | 'dom-mutation' | 'none';
  previousUrl?: string;
  currentUrl?: string;
}

export interface BatchStepResult {
  index: number;
  action: string;
  resultCategory: ResultCategory;
  successCategory?: SuccessCategory;
  failureCategory?: FailureCategory;
  error?: string;
}

export interface BrowserResult extends BackendCallResult {
  resultCategory: ResultCategory;
  successCategory?: SuccessCategory;
  failureCategory?: FailureCategory;
  nextActions?: NextAction[];
  pageChangeSummary?: PageChangeSummary;
  batchSteps?: BatchStepResult[];
  overlay?: OverlayProbe;
}

export interface EnrichContext {
  action: BrowserAction;
  errorMessage?: string;
  previousUrl?: string;
  currentUrl?: string;
}

const INSPECTION_ACTIONS: readonly BrowserAction[] = [
  'text', 'html', 'get_url', 'get_title', 'snapshot', 'tabs', 'cookies', 'status',
];

const FAILURE_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: FailureCategory }> = [
  { pattern: /timed out/i, category: 'timeout' },
  { pattern: /executable not found|cannot execute agent-browser/i, category: 'missing-binary' },
  { pattern: /element not found: @e|ref not found/i, category: 'stale-ref' },
  { pattern: /no active page|no open tab/i, category: 'no-active-page' },
  { pattern: /blocked by domain policy/i, category: 'domain-blocked' },
  { pattern: /disabled by policy/i, category: 'policy-denied' },
  { pattern: /covered by </i, category: 'overlay-blocked' },
  { pattern: /is required|unsupported browser action|must be/i, category: 'invalid-request' },
  { pattern: /process error:|exited with code/i, category: 'process-error' },
];

/** Classify a raw CLI/adapter failure message into a FailureCategory. */
export function classifyFailure(errorMessage: string): FailureCategory {
  for (const { pattern, category } of FAILURE_PATTERNS) {
    if (pattern.test(errorMessage)) return category;
  }
  return 'unknown';
}

/** Pick the default SuccessCategory for an action that succeeded. */
export function classifySuccess(action: BrowserAction): SuccessCategory {
  if ((INSPECTION_ACTIONS as readonly string[]).includes(action)) return 'inspection';
  if (action === 'screenshot') return 'artifact-unverified';
  return 'completed';
}

/** Build the follow-up suggestions for a given outcome. */
export function suggestNextActions(action: BrowserAction, failureCategory: FailureCategory | undefined): NextAction[] {
  if (!failureCategory) return [];

  switch (failureCategory) {
    case 'stale-ref':
      return [{ tool: 'browser', args: { action: 'snapshot' }, reason: 'Element ref is stale — take a fresh snapshot before retrying.' }];
    case 'no-active-page':
      return [{ tool: 'browser', args: { action: 'navigate' }, reason: 'No active page — navigate to a URL first.' }];
    case 'overlay-blocked':
      return [{ tool: 'browser', args: { action: 'snapshot' }, reason: 'An overlay is blocking the target element — snapshot to inspect the current page state.' }];
    case 'domain-blocked':
      return [{ tool: 'browser', args: { action: 'navigate' }, reason: 'Add the target domain to allowedDomains before navigating there.' }];
    case 'policy-denied':
      return [];
    case 'timeout':
      return [{ tool: 'browser', args: { action }, reason: 'The action timed out — retry once the page has settled.' }];
    case 'missing-binary':
    case 'process-error':
    case 'invalid-request':
    case 'dispatch-unverified':
    case 'unknown':
    default:
      return [];
  }
}

/** Wrap a raw BackendCallResult with resultCategory/successCategory/failureCategory/nextActions. */
export function enrichResult(result: BackendCallResult, ctx: EnrichContext): BrowserResult {
  const errorMessage = ctx.errorMessage;
  if (errorMessage) {
    const details = result.details as Record<string, unknown> | undefined;
    const failureCategory: FailureCategory = details?.dispatchUnverified === true
      ? 'dispatch-unverified'
      : details?.staleRef === true
        ? 'stale-ref'
        : classifyFailure(errorMessage);
    return {
      ...result,
      resultCategory: 'failure',
      failureCategory,
      nextActions: suggestNextActions(ctx.action, failureCategory),
    };
  }

  const details = result.details as Record<string, unknown> | undefined;
  const overlay = details?.overlay as OverlayProbe | undefined;
  const nextActions: NextAction[] = [];
  if (overlay?.appeared) {
    nextActions.push({
      tool: 'browser',
      args: { action: 'snapshot' },
      reason: 'An overlay appeared after the click — snapshot to locate the dismiss control.',
    });
  }

  return {
    ...result,
    resultCategory: 'success',
    successCategory: classifySuccess(ctx.action),
    ...(overlay ? { overlay } : {}),
    ...(nextActions.length > 0 ? { nextActions } : {}),
  };
}
