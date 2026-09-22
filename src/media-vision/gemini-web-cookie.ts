// Reach-backed Gemini Web cookie fallback.
//
// Separate from the preferred user-Chrome lease path. /reach-setup is the
// consent path that imports the sensitive Google session snapshot. Replay
// happens in a fresh isolated agent-browser session and is destroyed after use.
//
// Cookie values never enter tool/status output or argv: AgentBrowserAdapter's
// set_cookies path transports them through stdin.

import { resolve } from 'node:path';
import type { BackendCallResult } from '../backend.js';
import { AgentBrowserAdapter } from '../browser/agent-browser.js';
import type { AgentBrowserProcessOptions } from '../browser/agent-browser-process.js';
import {
  filterCookiesForDomains,
  storedCookiesForBrowserReplay,
  type BrowserCookie,
} from '../chrome/cookie-jar.js';
import {
  GEMINI_WEB_ORIGINS,
  GeminiWebLeaseUnavailableError,
  type GeminiWebLease,
} from './gemini-web.js';
import { isGeminiWebEnabled } from './eligibility.js';
import { isGeminiVideoEnabled } from './gemini.js';
import { isLeaseErrorText, leaseResultText } from './gemini-web-lease.js';

export const GEMINI_WEB_COOKIE_PROVIDER = 'vision-gemini-web';
export const GEMINI_WEB_COOKIE_DOMAINS = ['google.com'] as const;
/** Browser-level network containment for the isolated replay session. */
export const GEMINI_WEB_COOKIE_ALLOWED_DOMAINS = [
  'gemini.google.com',
  '*.google.com',
  '*.googleapis.com',
  '*.gstatic.com',
  '*.googleusercontent.com',
] as const;

interface CookieBrowserAdapter {
  setAllowedDomains(domains: string[]): void;
  execute(
    args: Record<string, unknown>,
    options?: AgentBrowserProcessOptions,
  ): Promise<BackendCallResult>;
  uploadFileForInternalUse(
    selector: string,
    filePath: string,
    options?: AgentBrowserProcessOptions,
  ): Promise<BackendCallResult>;
  close(): Promise<void>;
}

export interface GeminiWebCookieSeams {
  cookies?: (() => BrowserCookie[]) | undefined;
  createAdapter?: (() => CookieBrowserAdapter) | undefined;
  signal?: AbortSignal | undefined;
}

function fail(message: string): never {
  throw new GeminiWebLeaseUnavailableError(message);
}

function resultError(result: BackendCallResult): string | undefined {
  const record = result as BackendCallResult & {
    resultCategory?: unknown;
    details?: unknown;
  };
  if (record.resultCategory === 'failure') return 'browser operation failed';
  if (typeof record.details === 'object' && record.details !== null) {
    const details = record.details as Record<string, unknown>;
    if (typeof details.error === 'string' && details.error.trim()) {
      return details.error.slice(0, 160);
    }
  }
  const text = leaseResultText(result);
  if (isLeaseErrorText(text)) return text.slice(0, 160);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'string' && error.trim()) return error.slice(0, 160);
    }
  } catch {
    // Plain text is a valid read result.
  }
  return undefined;
}

function requireSuccess(result: BackendCallResult, op: string): string {
  const error = resultError(result);
  if (error !== undefined) {
    fail(`gemini-web-cookie-unavailable: ${op} failed (${error})`);
  }
  return leaseResultText(result);
}

class GeminiWebCookieLease implements GeminiWebLease {
  readonly origin = GEMINI_WEB_ORIGINS[0] as string;
  readonly warnings = ['gemini-web-cookie-fallback'] as const;
  private readonly adapter: CookieBrowserAdapter;
  private readonly options: AgentBrowserProcessOptions;
  private closed = false;

  constructor(
    adapter: CookieBrowserAdapter,
    env: Record<string, string | undefined>,
    signal?: AbortSignal,
  ) {
    this.adapter = adapter;
    // Private gate for the code-owned replay dispatch only. The child sandbox
    // strips PI_* vars, and process.env is never mutated.
    this.options = {
      env: { ...env, PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' },
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  private ensureOpen(): void {
    if (this.closed) {
      fail('gemini-web-cookie-unavailable: isolated cookie session already closed');
    }
    this.options.signal?.throwIfAborted();
  }

  async navigate(url: string): Promise<void> {
    this.ensureOpen();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail('gemini-web-cookie-unavailable: invalid navigation url');
    }
    if (!GEMINI_WEB_ORIGINS.includes(parsed!.origin)) {
      fail(`gemini-web-cookie-unavailable: navigation origin rejected (${parsed!.origin})`);
    }
    requireSuccess(
      await this.adapter.execute({ action: 'navigate', url }, this.options),
      'navigate',
    );
    this.ensureOpen();
    const current = requireSuccess(
      await this.adapter.execute({ action: 'get_url' }, this.options),
      'post-navigation check',
    ).trim();
    let origin: string;
    try {
      origin = new URL(current).origin;
    } catch {
      fail('gemini-web-cookie-unavailable: post-navigation url unreadable');
    }
    if (!GEMINI_WEB_ORIGINS.includes(origin!)) {
      fail(`gemini-web-cookie-unavailable: tab left gemini origin (${origin!})`);
    }
  }

  async attachFile(filePath: string): Promise<void> {
    this.ensureOpen();
    const absolute = resolve(filePath);
    requireSuccess(
      await this.adapter.uploadFileForInternalUse(
        'input[type="file"]',
        absolute,
        this.options,
      ),
      'video attachment',
    );
    this.ensureOpen();
  }

  async evaluate<T>(script: string): Promise<T> {
    this.ensureOpen();
    if (typeof script !== 'string' || !script.startsWith('prompt:')) {
      fail('gemini-web-cookie-unavailable: unsupported evaluate script (prompt envelope only)');
    }
    let prompt: string;
    try {
      prompt = JSON.parse(script.slice('prompt:'.length)) as string;
    } catch {
      fail('gemini-web-cookie-unavailable: malformed prompt envelope');
    }
    if (typeof prompt !== 'string' || prompt.trim().length === 0) return '' as T;
    const bounded = prompt.slice(0, 8000);

    requireSuccess(await this.adapter.execute({
      action: 'semanticAction',
      semanticAction: {
        locator: 'role',
        query: 'textbox',
        verb: 'fill',
        value: bounded,
      },
    }, this.options), 'prompt fill');
    this.ensureOpen();
    requireSuccess(await this.adapter.execute({
      action: 'semanticAction',
      semanticAction: {
        locator: 'role',
        query: 'button',
        name: 'Send message',
        verb: 'click',
      },
    }, this.options), 'prompt submit');
    this.ensureOpen();
    requireSuccess(
      await this.adapter.execute({ action: 'wait', waitMs: 10_000 }, this.options),
      'answer wait',
    );
    this.ensureOpen();
    const text = requireSuccess(
      await this.adapter.execute({ action: 'text' }, this.options),
      'answer read',
    );
    this.ensureOpen();
    return text as T;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.adapter.close();
  }
}

/** Acquire the isolated Reach-cookie fallback. Stored cookies never enable it
 * by themselves: both existing Gemini Web/video exact opt-ins are required. */
export async function acquireGeminiWebCookieLease(
  env: Record<string, string | undefined> = process.env,
  seams: GeminiWebCookieSeams = {},
): Promise<GeminiWebLease> {
  if (!isGeminiWebEnabled(env)) {
    fail('gemini-web-cookie disabled: set PI_VISION_GEMINI_WEB_ENABLED=1 to enable this route');
  }
  if (!isGeminiVideoEnabled(env)) {
    fail('gemini-web-cookie disabled: set PI_VISION_VIDEO_GEMINI=1 to enable the video fallback');
  }

  const allCookies =
    seams.cookies?.() ?? storedCookiesForBrowserReplay(GEMINI_WEB_COOKIE_PROVIDER, env);
  const cookies = filterCookiesForDomains(
    allCookies,
    [...GEMINI_WEB_COOKIE_DOMAINS],
  );
  if (cookies.length === 0) {
    fail(
      'gemini-web-cookie-unavailable: no Reach-imported Google session; ' +
      'run /reach-setup with Gemini Web enabled or ' +
      '/reach-setup import_cookies vision-gemini-web',
    );
  }

  const adapter = seams.createAdapter?.() ?? new AgentBrowserAdapter();
  try {
    adapter.setAllowedDomains([...GEMINI_WEB_COOKIE_ALLOWED_DOMAINS]);
    const options: AgentBrowserProcessOptions = {
      env: { ...env, PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' },
      ...(seams.signal !== undefined ? { signal: seams.signal } : {}),
    };
    requireSuccess(
      await adapter.execute({ action: 'set_cookies', cookies }, options),
      'cookie replay',
    );
    return new GeminiWebCookieLease(adapter, env, seams.signal);
  } catch (error) {
    try {
      await adapter.close();
    } catch {
      // best effort
    }
    if (error instanceof GeminiWebLeaseUnavailableError) throw error;
    if (error instanceof Error && error.message === 'Aborted') throw error;
    fail(
      'gemini-web-cookie-unavailable: cookie replay failed (' +
      (error instanceof Error ? error.message.slice(0, 160) : 'unknown') +
      ')',
    );
  }
}
