import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeCookieState } from '../../../src/chrome/cookie-jar.js';
import { fetchAuthenticatedReadablePage } from '../../../src/web/access/web-access-auth-fetch.js';
import {
  parseWebAccessAuthProfiles,
  PI_FETCH_AUTH_PROFILES_ENV,
} from '../../../src/web/access/web-access-auth-contract.js';

const HTML = '<html><head><title>R</title></head><body><article><p>redirect body</p></article></body></html>';

function htmlResponse(): Response {
  return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
}

function redirectTo(location: string): Response {
  return new Response('', { status: 302, headers: { location } });
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-auth-redirect-'));
  const env: Record<string, string | undefined> = {
    [PI_FETCH_AUTH_PROFILES_ENV]: JSON.stringify({
      yt: { provider: 'youtube', hosts: ['www.youtube.com'] },
    }),
    PI_SEARCH_STATE_DIR: dir,
  };
  await writeCookieState('youtube', [
    { name: 'session', value: 'yt-session-secret', domain: '.youtube.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
  ], env, 'fixture');
  return { dir, env, profiles: parseWebAccessAuthProfiles(env) };
}

test('cross-origin redirect refused without leaking cookies (T1)', async () => {
  const { dir, env, profiles } = await setup();
  const seen: string[] = [];
  const lookup = async (host: string) => {
    if (host === 'www.youtube.com' || host === 'music.youtube.com') {
      return [{ address: '93.184.216.34', family: 4 as const }];
    }
    throw Object.assign(new Error(`Blocked hostname: ${host}`), { code: 'ESSRF' });
  };
  try {
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/a', profiles.yt!, {
        env,
        lookup,
        fetchFn: (async (input: string) => {
          seen.push(input);
          if (input === 'https://www.youtube.com/a') return redirectTo('https://music.youtube.com/b');
          return htmlResponse();
        }) as typeof fetch,
      }),
      /refused a cross-origin redirect/,
    );
    assert.deepEqual(seen, ['https://www.youtube.com/a']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('https-to-http downgrade refused (T3)', async () => {
  const { dir, env, profiles } = await setup();
  try {
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/a', profiles.yt!, {
        env,
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
        fetchFn: (async (input: string) => {
          if (input === 'https://www.youtube.com/a') return redirectTo('http://www.youtube.com/a');
          return htmlResponse();
        }) as typeof fetch,
      }),
      /requires HTTPS for every redirect hop/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('private-resolving hop refused before any cookie attaches (T4)', async () => {
  const { dir, env, profiles } = await setup();
  let lookups = 0;
  const seen: Array<{ url: string; cookie: string | null }> = [];
  const lookup = async () => {
    lookups += 1;
    // DNS rebinding shape: the hop re-resolves the same host to private space.
    if (lookups === 1) return [{ address: '93.184.216.34', family: 4 as const }];
    return [{ address: '10.0.0.1', family: 4 as const }];
  };
  try {
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/a', profiles.yt!, {
        env,
        lookup,
        fetchFn: (async (input: string, init?: RequestInit) => {
          seen.push({ url: input, cookie: new Headers(init?.headers).get('cookie') });
          if (input === 'https://www.youtube.com/a') return redirectTo('https://www.youtube.com:8080/private');
          return htmlResponse();
        }) as typeof fetch,
      }),
      /redirect target blocked/,
    );
    // Port change is also cross-origin, but the DNS refusal fires first and no
    // second request (with cookies) ever leaves the machine.
    assert.equal(seen.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hop limit, missing Location, and invalid Location reject (fixed messages)', async () => {
  const { dir, env, profiles } = await setup();
  const lookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
  try {
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/a', profiles.yt!, {
        env,
        lookup,
        fetchFn: (async (input: string) => {
          const hop = Number(input.split('/hop')[1]);
          if (Number.isFinite(hop) && hop < 9) return redirectTo(`https://www.youtube.com/hop${hop + 1}`);
          if (input === 'https://www.youtube.com/a') return redirectTo('https://www.youtube.com/hop1');
          return htmlResponse();
        }) as typeof fetch,
      }),
      /exceeded the redirect limit/,
    );
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/a', profiles.yt!, {
        env,
        lookup,
        fetchFn: (async () => new Response('', { status: 302 })) as typeof fetch,
      }),
      /without a valid Location header/,
    );
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/a', profiles.yt!, {
        env,
        lookup,
        fetchFn: (async () => redirectTo('https://exa mple.com/ bad')) as typeof fetch,
      }),
      /redirect target rejected/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('same-origin multi-hop chain succeeds with per-hop cookies', async () => {
  const { dir, env, profiles } = await setup();
  const cookies: Array<string | null> = [];
  try {
    const page = await fetchAuthenticatedReadablePage('https://www.youtube.com/a', profiles.yt!, {
      env,
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      fetchFn: (async (input: string, init?: RequestInit) => {
        cookies.push(new Headers(init?.headers).get('cookie'));
        if (input === 'https://www.youtube.com/a') return redirectTo('/b');
        return htmlResponse();
      }) as typeof fetch,
    });
    assert.match(page.content, /redirect body/);
    assert.equal(cookies.length, 2);
    assert.match(cookies[0] ?? '', /yt-session-secret/);
    assert.match(cookies[1] ?? '', /yt-session-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
