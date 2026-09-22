// Real Gemini Web lease over the Chrome session owners (Plan D).
//
// Adapts the closest Chrome session API (ChromeProfileAdapter.execute +
// Pi-side auth lock + operator companion selection + pinned bridge owner)
// using allowed operations only. The closed Chrome operation union forbids
// evaluate/html/cookies, so this lease never executes scripts: navigate is
// exact-origin confined, the prompt is submitted with a code-owned
// semantic_action fill (fixed locator/query/verb, never model input), and
// the answer is read back with text. Every step re-checks the live user
// authorization lease; revoke/expiry/failure/shutdown fails closed to the
// isolated backend via GeminiWebLeaseUnavailableError, never fake success.
//
// No credentials, cookies, tokens, or page content are stored here. The
// prompt travels to the companion as a typed page payload only.

import {
  GEMINI_WEB_ORIGINS,
  GeminiWebLeaseUnavailableError,
  type GeminiWebLease,
} from './gemini-web.js';
import { isGeminiWebEnabled } from './eligibility.js';
import { GEMINI_VIDEO_ENABLED_ENV_VAR, isGeminiVideoEnabled } from './gemini.js';


/** Minimal owner surface this lease adapts. Mirrors the public
 * ChromeProfileAdapter shape (status lock + bound target + execute) plus
 * the pinned bridge owner check. Owners are injected, never imported, so
 * this module takes no ambient authority and grants nothing.
 *
 * execute() resolves BackendCallResult-shaped payloads: Chrome failures
 * arrive as results (details.chromeError and/or {ok:false} text), not
 * throws, so every dispatch result must pass requireOwnerSuccess(). */
export interface GeminiWebChromeOwners {
  /** True only with a live user authorization lease (authorized + executable grant). */
  isAuthorized(): boolean;
  /** Operator-selected companion instanceId; null/empty means no selection. */
  boundTarget(): string | null;
  /** Throws unless this process owns the pinned companion bridge. */
  requireBridgeOwner(): void;
  /** ChromeProfileAdapter.execute: allowed browser actions only. */
  execute(args: Record<string, unknown>): Promise<{ content?: unknown; details?: unknown }>;
}

export type GeminiWebLeaseEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

function fail(message: string): never {
  throw new GeminiWebLeaseUnavailableError(message);
}

/** True when adapter text is an {ok:false} error envelope, not an answer.
 * Chrome failures arrive as results: chromeErrorResult() encodes
 * {ok:false, error} as text content alongside details.chromeError. */
export function isLeaseErrorText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { ok?: unknown }).ok === false
    );
  } catch {
    return false;
  }
}

/** Fail closed unless an owner dispatch result is a real success.
 * Inspects details.chromeError and {ok:false} text before any caller
 * consumes the payload: a revoke racing dispatch (or any owner failure)
 * surfaces here as lease-unavailable, never as answer text. */
function requireOwnerSuccess(result: { content?: unknown; details?: unknown }, op: string): string {
  const details = (result as { details?: unknown }).details;
  if (typeof details === 'object' && details !== null) {
    const chromeError = (details as { chromeError?: unknown }).chromeError;
    if (typeof chromeError === 'object' && chromeError !== null) {
      const code = (chromeError as { code?: unknown }).code;
      const message = (chromeError as { message?: unknown }).message;
      fail(
        `gemini-web-lease-unavailable: ${op} rejected (${typeof code === 'string' ? code : 'chrome_error'}: ${typeof message === 'string' ? message.slice(0, 120) : 'owner failure'}; degraded to isolated backend`,
      );
    }
  }
  const text = leaseResultText(result);
  if (isLeaseErrorText(text)) {
    fail(
      `gemini-web-lease-unavailable: ${op} returned error result (${text.slice(0, 120)}; degraded to isolated backend)`,
    );
  }
  return text;
}
export function leaseResultText(result: { content?: unknown }): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * Acquire a real leased Gemini Web tab from the Chrome owners.
 *
 * Triple gate (all required):
 * 1. PI_VISION_GEMINI_WEB_ENABLED=1 (web route opt-in).
 * 2. PI_VISION_VIDEO_GEMINI=1 (video Gemini fallback opt-in).
 * 3. Live user authorization lease: pinned bridge owner + authorized grant
 *    + operator-selected companion target.
 *
 * Inventory/selection stays operator-facing: a missing/empty bound target
 * fails closed here (never auto-selected, never model input). Throws
 * GeminiWebLeaseUnavailableError on every unavailable path; never resolves
 * a fake lease.
 */
export async function acquireChromeGeminiWebLease(
  env: GeminiWebLeaseEnv = process.env,
  owners?: GeminiWebChromeOwners | undefined,
): Promise<GeminiWebLease> {
  if (!isGeminiWebEnabled(env)) {
    fail('gemini-web disabled: set PI_VISION_GEMINI_WEB_ENABLED=1 to enable this route');
  }
  if (!isGeminiVideoEnabled(env)) {
    fail(`gemini-web disabled: set ${GEMINI_VIDEO_ENABLED_ENV_VAR}=1 to enable the video Gemini fallback`);
  }
  if (owners === undefined) {
    fail('gemini-web-lease-unavailable: no Chrome owners wired; degraded to isolated backend');
  }
  try {
    owners.requireBridgeOwner();
  } catch (error) {
    fail(
      `gemini-web-lease-unavailable: pinned companion bridge owner required (${error instanceof Error ? error.message.slice(0, 120) : 'not owner'})`,
    );
  }
  if (!owners.isAuthorized()) {
    fail('gemini-web-lease-unavailable: user-chrome control locked; run /chrome-authorize first');
  }
  const target = owners.boundTarget();
  if (typeof target !== 'string' || target.length === 0) {
    fail('gemini-web-lease-unavailable: no companion selected; operator selection required');
  }
  return new ChromeGeminiWebLease(owners, target);
}

class ChromeGeminiWebLease implements GeminiWebLease {
  readonly origin: string;
  private readonly owners: GeminiWebChromeOwners;
  private readonly target: string;

  constructor(owners: GeminiWebChromeOwners, target: string) {
    this.owners = owners;
    this.target = target;
    this.origin = GEMINI_WEB_ORIGINS[0] as string;
  }

  /** Live-grant + target-identity re-check before every tab operation. */
  private checkLive(): void {
    try {
      this.owners.requireBridgeOwner();
    } catch {
      fail('gemini-web-lease-unavailable: bridge owner lost; degraded to isolated backend');
    }
    if (!this.owners.isAuthorized()) {
      fail('gemini-web-lease-unavailable: lease revoked or expired; degraded to isolated backend');
    }
    if (this.owners.boundTarget() !== this.target) {
      fail('gemini-web-lease-unavailable: companion selection changed during lease; degraded to isolated backend');
    }
  }

  async navigate(url: string): Promise<void> {
    this.checkLive();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail('gemini-web-lease-unavailable: invalid navigation url');
    }
    if (!GEMINI_WEB_ORIGINS.includes(parsed!.origin)) {
      fail(`gemini-web-lease-unavailable: navigation origin rejected (${parsed!.origin})`);
    }
    let result: { content?: unknown; details?: unknown };
    try {
      result = await this.owners.execute({ action: 'navigate', url });
    } catch (error) {
      fail(
        `gemini-web-lease-unavailable: navigation failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'})`,
      );
    }
    requireOwnerSuccess(result!, 'navigate');
    // Exact-origin confinement: compare the full post-navigation origin
    // (scheme + host + port) against GEMINI_WEB_ORIGINS. Hostname-only
    // checks would admit scheme/port swaps, so any drift fails closed.
    // Re-check the live grant before the probe: a revoke racing navigate
    // surfaces via the probe's result validation below.
    this.checkLive();
    let current: { content?: unknown; details?: unknown };
    try {
      current = await this.owners.execute({ action: 'get_url' });
    } catch (error) {
      fail(
        `gemini-web-lease-unavailable: post-navigation check failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'})`,
      );
    }
    const currentUrl = requireOwnerSuccess(current!, 'post-navigation check').trim();
    // Post-probe live re-check: a revoke racing get_url must fail closed
    // here even when the probe itself returned a gemini URL.
    this.checkLive();
    let currentOrigin: string;
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      fail('gemini-web-lease-unavailable: post-navigation url unreadable; degraded to isolated backend');
    }
    if (!GEMINI_WEB_ORIGINS.includes(currentOrigin!)) {
      fail(`gemini-web-lease-unavailable: tab left gemini origin (${currentOrigin!}); degraded to isolated backend`);
    }
  }

  /**
   * Submit the prompt envelope through allowed ops and read the answer.
   * The closed Chrome union forbids script execution, so `script` must be
   * the askGeminiWeb `prompt:<json>` envelope; the prompt is submitted with
   * a code-owned semantic_action fill and the answer is read with text.
   * Only string answers are supported. Any owner failure throws
   * lease-unavailable; empty answers resolve to '' for the caller to classify.
   */
  async evaluate<T>(script: string): Promise<T> {
    this.checkLive();
    if (typeof script !== 'string' || !script.startsWith('prompt:')) {
      fail('gemini-web-lease-unavailable: unsupported evaluate script (prompt envelope only)');
    }
    let prompt: string;
    try {
      prompt = JSON.parse(script.slice('prompt:'.length)) as string;
    } catch {
      fail('gemini-web-lease-unavailable: malformed prompt envelope');
    }
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return '' as T;
    }
    const bounded = prompt.slice(0, 8000);
    try {
      // Code-owned locator/query/verb: fixed values below, never model input.
      // The prompt travels as the fill value (typed page payload) only.
      // The live grant is re-checked before EACH dispatch: a revoke racing
      // one op surfaces via that op's result validation, never as success.
      await this.owners.execute({
        action: 'semanticAction',
        semanticAction: {
          locator: 'role',
          query: 'textbox',
          verb: 'fill',
          value: bounded,
        },
      }).then((dispatched) => requireOwnerSuccess(dispatched, 'prompt fill'));
      this.checkLive();
      await this.owners.execute({
        action: 'semanticAction',
        semanticAction: {
          locator: 'role',
          query: 'button',
          name: 'Send message',
          verb: 'click',
        },
      }).then((dispatched) => requireOwnerSuccess(dispatched, 'prompt submit'));
      this.checkLive();
      await this.owners.execute({ action: 'wait', waitMs: 10_000 }).then((dispatched) =>
        requireOwnerSuccess(dispatched, 'answer wait'),
      );
      this.checkLive();
      const read = await this.owners.execute({ action: 'text' });
      const text = requireOwnerSuccess(read, 'answer read');
      // Post-op live re-check: a revoke racing the final text dispatch must
      // fail closed here and never be returned as an answer.
      this.checkLive();
      if (text.trim().length === 0) return '' as T;
      return text as T;
    } catch (error) {
      if (error instanceof GeminiWebLeaseUnavailableError) throw error;
      fail(
        `gemini-web-lease-unavailable: companion ask failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'})`,
      );
    }
  }
}
