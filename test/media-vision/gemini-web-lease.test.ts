// Tests for the real Gemini Web Chrome lease (allowed ops only, fail-closed).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireChromeGeminiWebLease,
  leaseResultText,
  type GeminiWebChromeOwners,
} from '../../src/media-vision/gemini-web-lease.js';
import {
  acquireGeminiWebLeaseFromChromeOwners,
  GEMINI_WEB_ORIGINS,
  isGeminiWebLeaseUnavailableError,
} from '../../src/media-vision/gemini-web.js';

const GATED_ENV: Record<string, string | undefined> = {
  PI_VISION_GEMINI_WEB_ENABLED: '1',
  PI_VISION_VIDEO_GEMINI: '1',
};

function textResult(text: string): { content: unknown } {
  return { content: [{ type: 'text', text }] };
}

function makeOwners(
  overrides: Partial<GeminiWebChromeOwners> & { log?: unknown[] } = {},
): GeminiWebChromeOwners & { log: unknown[] } {
  const log: unknown[] = overrides.log ?? [];
  return {
    log,
    isAuthorized: overrides.isAuthorized ?? (() => true),
    boundTarget: overrides.boundTarget ?? (() => 'instance-1'),
    requireBridgeOwner: overrides.requireBridgeOwner ?? (() => {}),
    execute:
      overrides.execute ??
      (async (args: Record<string, unknown>) => {
        log.push(args);
        const action = args['action'];
        if (action === 'navigate') return textResult(JSON.stringify({ ok: true }));
        if (action === 'get_url') return textResult('https://gemini.google.com/app');
        if (action === 'text') return textResult('answer text');
        return textResult(JSON.stringify({ ok: true }));
      }),
  };
}

async function throwsLeaseUnavailable(promise: Promise<unknown>, match: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(isGeminiWebLeaseUnavailableError(error), `expected lease-unavailable, got: ${String(error)}`);
  assert.match(String((error as Error).message), match);
}

describe('acquireChromeGeminiWebLease triple gate', () => {
  it('disabled web flag throws first (distinguishable from missing lease)', async () => {
    await throwsLeaseUnavailable(acquireChromeGeminiWebLease({}), /PI_VISION_GEMINI_WEB_ENABLED/);
  });

  it('web enabled but video flag off throws video-gate error', async () => {
    await throwsLeaseUnavailable(
      acquireChromeGeminiWebLease({ PI_VISION_GEMINI_WEB_ENABLED: '1' }),
      /PI_VISION_VIDEO_GEMINI/,
    );
  });

  it('no owners wired never resolves fake success', async () => {
    await throwsLeaseUnavailable(acquireChromeGeminiWebLease(GATED_ENV), /no Chrome owners wired/);
  });

  it('locked (no live user lease) fails closed', async () => {
    await throwsLeaseUnavailable(
      acquireChromeGeminiWebLease(GATED_ENV, makeOwners({ isAuthorized: () => false })),
      /locked|authorize/,
    );
  });

  it('missing operator selection fails closed (no auto-select)', async () => {
    await throwsLeaseUnavailable(
      acquireChromeGeminiWebLease(GATED_ENV, makeOwners({ boundTarget: () => null })),
      /selection/,
    );
  });

  it('non-owner bridge process fails closed', async () => {
    const owners = makeOwners({
      requireBridgeOwner: () => {
        throw new Error('bridge shared by another process');
      },
    });
    await throwsLeaseUnavailable(acquireChromeGeminiWebLease(GATED_ENV, owners), /bridge owner/);
  });
});

describe('leased tab exact-origin confinement', () => {
  it('non-gemini navigation rejected before dispatch', async () => {
    const owners = makeOwners();
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(lease.navigate('https://evil.example/phish'), /origin rejected/);
    assert.deepEqual(owners.log, []);
  });

  it('post-redirect host widening fails closed', async () => {
    const owners = makeOwners({
      execute: async (args: Record<string, unknown>) => {
        if (args['action'] === 'navigate') return textResult('{}');
        return textResult('https://accounts.google.com/login');
      },
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app'), /left gemini/);
  });

  it('revoke between acquire and use fails closed', async () => {
    let live = true;
    const owners = makeOwners({ isAuthorized: () => live });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    live = false;
    await throwsLeaseUnavailable(lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app'), /revoked or expired/);
  });

  it('companion target is pinned for the lifetime of the lease', async () => {
    let target = 'instance-1';
    const owners = makeOwners({ boundTarget: () => target });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    target = 'instance-2';
    await throwsLeaseUnavailable(
      lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app'),
      /companion selection changed/,
    );
    assert.deepEqual(owners.log, [], 'target drift must fail before dispatching into another companion');
  });
});

describe('leased ask via allowed ops', () => {
  it('prompt envelope submits fill and reads text', async () => {
    const owners = makeOwners();
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app');
    const text = await lease.evaluate<string>(`prompt:${JSON.stringify('Describe this video')}`);
    assert.equal(text, 'answer text');
    const actions = owners.log.map((entry) => (entry as Record<string, unknown>)['action']);
    assert.deepEqual(actions, ['navigate', 'get_url', 'semanticAction', 'semanticAction', 'wait', 'text']);
    const fill = owners.log[2] as Record<string, unknown>;
    const submit = owners.log[3] as Record<string, unknown>;
    assert.deepEqual(fill['semanticAction'], {
      locator: 'role',
      query: 'textbox',
      verb: 'fill',
      value: 'Describe this video',
    });
    assert.deepEqual(submit['semanticAction'], {
      locator: 'role',
      query: 'button',
      name: 'Send message',
      verb: 'click',
    });
  });

  it('non-prompt script rejected (no arbitrary eval)', async () => {
    const owners = makeOwners();
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(lease.evaluate('document.cookie'), /prompt envelope only/);
  });

  it('owner failure degrades, never fake success', async () => {
    const owners = makeOwners({
      execute: async () => {
        throw new Error('chrome_revoked: command revoked before completion');
      },
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(
      lease.evaluate(`prompt:${JSON.stringify('hi')}`),
      /lease-unavailable/,
    );
  });
});

describe('leaseResultText', () => {
  it('joins text items, ignores non-text', () => {
    assert.equal(leaseResultText(textResult('a')), 'a');
    assert.equal(leaseResultText({ content: [{ type: 'image', data: 'x' }] }), '');
    assert.equal(leaseResultText({}), '');
  });
});

describe('regression: exact-origin confinement (scheme + host + port)', () => {
  it('http scheme swap rejected before dispatch', async () => {
    const owners = makeOwners();
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(lease.navigate('http://gemini.google.com/app'), /origin rejected/);
    assert.deepEqual(owners.log, []);
  });

  it('port swap on post-navigation url fails closed', async () => {
    const owners = makeOwners({
      execute: async (args: Record<string, unknown>) => {
        if (args['action'] === 'navigate') return textResult(JSON.stringify({ ok: true }));
        return textResult('https://gemini.google.com:8443/app');
      },
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app'), /left gemini origin/);
  });
});

describe('regression: owner error results never become answers', () => {
  it('details.chromeError on navigate fails closed', async () => {
    const owners = makeOwners({
      execute: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'locked' }) }],
        details: { chromeError: { code: 'chrome_locked', message: 'locked', retryable: false } },
      }),
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app'), /chrome_locked/);
  });

  it('{ok:false} text without details fails closed', async () => {
    const owners = makeOwners({
      execute: async () => textResult(JSON.stringify({ ok: false, error: 'revoked' })),
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await throwsLeaseUnavailable(lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app'), /error result/);
  });

  it('isLeaseErrorText detects error envelopes, ignores answers', async () => {
    const { isLeaseErrorText } = await import('../../src/media-vision/gemini-web-lease.js');
    assert.equal(isLeaseErrorText(JSON.stringify({ ok: false, error: 'x' })), true);
    assert.equal(isLeaseErrorText(JSON.stringify({ ok: true })), false);
    assert.equal(isLeaseErrorText('plain answer text'), false);
    assert.equal(isLeaseErrorText(''), false);
  });
});

describe('regression: revoke racing mid-sequence fails closed', () => {
  it('revoke during the actual wait call fails closed (per-op live check)', async () => {
    let live = true;
    const owners = makeOwners({
      isAuthorized: () => live,
      execute: async (args: Record<string, unknown>) => {
        if (args['action'] === 'wait') {
          live = false; // revoke lands while the wait dispatch is in flight
          return textResult(JSON.stringify({ ok: true }));
        }
        if (args['action'] === 'get_url') return textResult(GEMINI_WEB_ORIGINS[0] + '/app');
        if (args['action'] === 'text') return textResult('answer text');
        return textResult(JSON.stringify({ ok: true }));
      },
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app');
    await throwsLeaseUnavailable(
      lease.evaluate(`prompt:${JSON.stringify('hi')}`),
      /revoked or expired/,
    );
  });

  it('revoke during the actual text call never returns an answer (post-op live check)', async () => {
    let live = true;
    const owners = makeOwners({
      isAuthorized: () => live,
      execute: async (args: Record<string, unknown>) => {
        if (args['action'] === 'text') {
          live = false; // revoke lands while the final text dispatch is in flight
          return textResult('answer text');
        }
        if (args['action'] === 'get_url') return textResult(GEMINI_WEB_ORIGINS[0] + '/app');
        return textResult(JSON.stringify({ ok: true }));
      },
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app');
    await throwsLeaseUnavailable(
      lease.evaluate(`prompt:${JSON.stringify('hi')}`),
      /revoked or expired/,
    );
  });

  it('chromeError racing the text read fails closed via result validation', async () => {
    const owners = makeOwners({
      execute: async (args: Record<string, unknown>) => {
        if (args['action'] === 'get_url') return textResult(GEMINI_WEB_ORIGINS[0] + '/app');
        if (args['action'] === 'text') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'revoked' }) }],
            details: { chromeError: { code: 'chrome_revoked', message: 'revoked', retryable: false } },
          };
        }
        return textResult(JSON.stringify({ ok: true }));
      },
    });
    const lease = await acquireChromeGeminiWebLease(GATED_ENV, owners);
    await lease.navigate(GEMINI_WEB_ORIGINS[0] + '/app');
    await throwsLeaseUnavailable(
      lease.evaluate(`prompt:${JSON.stringify('hi')}`),
      /chrome_revoked/,
    );
  });
});

describe('acquireGeminiWebLeaseFromChromeOwners delegation', () => {
  it('no owners still fail-closed stub', async () => {
    await throwsLeaseUnavailable(acquireGeminiWebLeaseFromChromeOwners(GATED_ENV), /no Chrome owners wired/);
  });

  it('with owners returns a real lease bound to a gemini origin', async () => {
    const lease = await acquireGeminiWebLeaseFromChromeOwners(GATED_ENV, makeOwners());
    assert.ok(GEMINI_WEB_ORIGINS.includes(lease.origin as (typeof GEMINI_WEB_ORIGINS)[number]));
  });
});
