import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BackendCallResult } from '../../src/backend.js';
import type { AgentBrowserProcessOptions } from '../../src/browser/agent-browser-process.js';
import type { BrowserCookie } from '../../src/chrome/cookie-jar.js';
import {
  acquireGeminiWebCookieLease,
  GEMINI_WEB_COOKIE_ALLOWED_DOMAINS,
} from '../../src/media-vision/gemini-web-cookie.js';
import {
  askGeminiWeb,
  isGeminiWebLeaseUnavailableError,
} from '../../src/media-vision/gemini-web.js';

const GATED_ENV: Record<string, string | undefined> = {
  PI_VISION_GEMINI_WEB_ENABLED: '1',
  PI_VISION_VIDEO_GEMINI: '1',
};

function result(text: string): BackendCallResult {
  return { content: [{ type: 'text', text }] };
}

const COOKIE: BrowserCookie = {
  name: '__Secure-1PSID',
  value: 'SENTINEL-GOOGLE-SESSION-SECRET',
  domain: '.google.com',
  path: '/',
  expires: Math.floor(Date.now() / 1000) + 3600,
  httpOnly: true,
  secure: true,
  sameSite: 'None',
};

class FakeAdapter {
  readonly actions: Array<{
    args: Record<string, unknown>;
    options?: AgentBrowserProcessOptions;
  }> = [];
  allowed: string[] = [];
  closed = 0;
  currentUrl = 'https://gemini.google.com/app';

  setAllowedDomains(domains: string[]): void {
    this.allowed = [...domains];
  }

  async execute(
    args: Record<string, unknown>,
    options?: AgentBrowserProcessOptions,
  ): Promise<BackendCallResult> {
    this.actions.push({
      args,
      ...(options !== undefined ? { options } : {}),
    });
    switch (args.action) {
      case 'set_cookies':
        return result(JSON.stringify({ ok: true, count: 1 }));
      case 'navigate':
        return result(JSON.stringify({ ok: true }));
      case 'get_url':
        return result(this.currentUrl);
      case 'semanticAction':
      case 'wait':
        return result(JSON.stringify({ ok: true }));
      case 'text':
        return result('Gemini answer text');
      default:
        return result(JSON.stringify({ ok: false, error: 'unexpected action' }));
    }
  }

  async uploadFileForInternalUse(
    selector: string,
    filePath: string,
    options?: AgentBrowserProcessOptions,
  ): Promise<BackendCallResult> {
    this.actions.push({
      args: { action: 'internal_upload', selector, filePath },
      ...(options !== undefined ? { options } : {}),
    });
    return result(JSON.stringify({ ok: true }));
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('Gemini Web Reach-cookie fallback', () => {
  it('requires both existing exact opt-ins before reading cookie state', async () => {
    let cookieReads = 0;
    const error = await captureError(acquireGeminiWebCookieLease(
      { PI_VISION_GEMINI_WEB_ENABLED: '1' },
      { cookies: () => { cookieReads += 1; return [COOKIE]; } },
    ));
    assert.ok(isGeminiWebLeaseUnavailableError(error));
    assert.match(String((error as Error).message), /PI_VISION_VIDEO_GEMINI/);
    assert.equal(cookieReads, 0);
  });

  it('fails closed when Reach has no imported Google session', async () => {
    let adapterCreates = 0;
    const error = await captureError(acquireGeminiWebCookieLease(GATED_ENV, {
      cookies: () => [],
      createAdapter: () => {
        adapterCreates += 1;
        return new FakeAdapter();
      },
    }));
    assert.ok(isGeminiWebLeaseUnavailableError(error));
    assert.match(String((error as Error).message), /reach-setup/i);
    assert.equal(adapterCreates, 0, 'no browser starts without imported session state');
  });

  it('replays cookies privately, submits a prompt, and destroys the isolated session', async () => {
    const adapter = new FakeAdapter();
    const baseEnv = { ...GATED_ENV };
    const out = await askGeminiWeb('Describe this video', {
      acquireLease: () => acquireGeminiWebCookieLease(baseEnv, {
        cookies: () => [COOKIE],
        createAdapter: () => adapter,
      }),
    }, baseEnv);

    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.text, 'Gemini answer text');
    assert.ok(out.warnings.includes('gemini-web-cookie-fallback'));
    assert.deepEqual(adapter.allowed, [...GEMINI_WEB_COOKIE_ALLOWED_DOMAINS]);
    assert.equal(adapter.closed, 1, 'ask cleanup closes the isolated replay session');

    const actions = adapter.actions.map((entry) => entry.args.action);
    assert.deepEqual(actions, [
      'set_cookies',
      'navigate',
      'get_url',
      'semanticAction',
      'semanticAction',
      'wait',
      'text',
    ]);
    const replay = adapter.actions[0]!;
    assert.equal(
      (replay.options?.env as Record<string, string | undefined>)?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE,
      '1',
      'code-owned replay gate is scoped to the private dispatch options',
    );
    assert.equal(baseEnv.PI_SEARCH_BROWSER_ALLOW_SENSITIVE, undefined, 'caller environment is not mutated');
    const replayCookies = replay.args.cookies as BrowserCookie[];
    assert.equal(replayCookies[0]?.value, COOKIE.value, 'cookie reaches only the private adapter seam');

    const fill = adapter.actions[3]!.args.semanticAction as Record<string, unknown>;
    const submit = adapter.actions[4]!.args.semanticAction as Record<string, unknown>;
    assert.deepEqual(fill, {
      locator: 'role',
      query: 'textbox',
      verb: 'fill',
      value: 'Describe this video',
    });
    assert.deepEqual(submit, {
      locator: 'role',
      query: 'button',
      name: 'Send message',
      verb: 'click',
    });
  });

  it('fails closed on post-navigation origin drift and still cleans up', async () => {
    const adapter = new FakeAdapter();
    adapter.currentUrl = 'https://accounts.google.com/login';
    const error = await captureError(askGeminiWeb('hello', {
      acquireLease: () => acquireGeminiWebCookieLease(GATED_ENV, {
        cookies: () => [COOKIE],
        createAdapter: () => adapter,
      }),
    }, GATED_ENV));
    assert.ok(isGeminiWebLeaseUnavailableError(error));
    assert.match(String((error as Error).message), /left gemini origin/);
    assert.equal(adapter.closed, 1);
  });
});
