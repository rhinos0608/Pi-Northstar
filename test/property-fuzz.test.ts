import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeUrl } from '../src/search/fusion.js';
import { validateHttpUrl } from '../src/core/http.js';
import {
  buildNorthstarResult,
  decodeResultCursor,
  encodeResultCursor,
  parseEntity,
  validateNorthstarEntity,
  validateNorthstarResult,
} from '../src/result-contract.js';
import {
  decodeGithubCursor,
  encodeGithubCursor,
  githubCursorFingerprint,
} from '../src/github/github-contract.js';
import {
  parseChromeBridgeCommand,
  parseChromeBridgeResult,
  parseChromeProfileOperation,
} from '../src/chrome/chrome-profile-contract.js';
import { runSetupInstall } from '../src/setup/installer.js';
import { validateReply, validateRequest } from '../src/runtime/runtime-rpc-protocol.js';
import {
  ChromeBridgeServer,
  parseBridgeInstanceClaim,
} from '../src/chrome/chrome-profile-bridge.js';

// Deterministic seeded PRNG (mulberry32). No dependencies.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x9e3779b9);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789';
const str = (n: number): string =>
  Array.from({ length: n }, () => alnum[Math.floor(rand() * alnum.length)]!).join('');

const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid', 'msclkid', '_ga', '_gl'];
const LEGIT = ['q', 'page', 'lang', 'sort'];

describe('property: URL canonicalization', () => {
  it('strips tracking params, lowercases host, drops www/hash; idempotent', () => {
    for (let i = 0; i < 200; i++) {
      const scheme = pick(['https', 'HTTPS', 'Https'] as const);
      const www = rand() < 0.5 ? 'www.' : '';
      const host = `Example${i % 7}.COM`;
      const path = `/a/b${rand() < 0.5 ? '/' : ''}`;
      const tkey = pick(TRACKING);
      const lkey = pick(LEGIT);
      const raw = `${scheme}://${www}${host}:443${path}?${tkey}=x&${lkey}=1#frag`;
      const out = normalizeUrl(raw);
      const u = new URL(out);
      assert.equal(u.hostname, `example${i % 7}.com`);
      assert.equal(u.hash, '');
      assert.ok(!TRACKING.some((t) => out.includes(t)), `tracking leaked: ${out}`);
      assert.ok(out.includes(`${lkey}=1`), `legit param dropped: ${out}`);
      assert.equal(normalizeUrl(out), out, `not idempotent: ${out}`);
    }
  });

  it('trailing slash collapses; root stays /', () => {
    for (let i = 0; i < 50; i++) {
      const out = normalizeUrl(`https://example.com/a/${'b/'.repeat(i % 3)}`);
      assert.ok(!out.endsWith('/') || out.endsWith('://example.com/'), out);
      assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
    }
  });

  it('credentialed URLs rejected fail-closed by validateHttpUrl', () => {
    for (let i = 0; i < 50; i++) {
      const raw = `https://user${i}:pass${i}@example.com/path?q=1`;
      assert.throws(() => validateHttpUrl(raw), /credentials/);
      // '@' in path/query is not userinfo and must not false-positive
      const safe = `https://example.com/p@th?q=a@${i}`;
      assert.doesNotThrow(() => validateHttpUrl(safe));
    }
    assert.throws(() => validateHttpUrl('ftp://example.com/x'), /scheme/);
  });
});

describe('property: opaque cursor round-trip', () => {
  it('result cursors round-trip; malformed/mismatched rejected', () => {
    for (let i = 0; i < 150; i++) {
      const input = {
        source: pick(['openalex', 'pubmed', 'arxiv'] as const),
        query: `q-${str(6)} ${i}`,
        yearFrom: rand() < 0.5 ? 2000 + (i % 25) : undefined,
        state: { page: i % 11, token: str(8), flag: rand() < 0.5 },
      };
      const expected: { source: string; query: string; yearFrom?: number } = { source: input.source, query: input.query };
      if (input.yearFrom !== undefined) expected.yearFrom = input.yearFrom;
      const cursor = encodeResultCursor({ source: input.source, query: input.query, ...(input.yearFrom !== undefined ? { yearFrom: input.yearFrom } : {}), state: input.state });
      assert.ok(cursor.length <= 4096);
      const decoded = decodeResultCursor(cursor, expected);
      assert.deepEqual(decoded.state, input.state);

      // Malformed variants fail closed
      assert.throws(() => decodeResultCursor(cursor.slice(0, cursor.length - 2) + '%%', expected));
      assert.throws(() => decodeResultCursor('', expected));
      assert.throws(() => decodeResultCursor('not-base64!!!', expected));
      // Wrong binding rejected
      assert.throws(() => decodeResultCursor(cursor, { ...expected, query: 'other' }));
      assert.throws(() => decodeResultCursor(cursor, { ...expected, source: expected.source === 'zzz-nope' ? 'pubmed' : 'zzz-nope' }));
      assert.throws(() => decodeResultCursor(cursor, { source: 'all', query: input.query }));
      // Oversize rejected
      assert.throws(() => decodeResultCursor('A'.repeat(4097), expected));
    }
  });

  it('github cursors round-trip; tamper/mismatch rejected', () => {
    for (let i = 0; i < 100; i++) {
      const action = pick(['issues', 'pulls', 'commits', 'search'] as const);
      const fp = githubCursorFingerprint({ action: action as never, owner: 'o', repo: 'r', limit: 10 });
      const cursor = encodeGithubCursor({
        action: action as never,
        backend: 'github-api',
        fingerprint: fp,
        state: { page: (i % 5) + 2 },
      });
      const decoded = decodeGithubCursor(cursor, { action: action as never, backend: 'github-api', fingerprint: fp });
      assert.deepEqual(decoded.state, { page: (i % 5) + 2 });
      // Tampered payload rejected
      const tampered = cursor.slice(0, -2) + (cursor.endsWith('AA') ? 'BB' : 'AA');
      assert.throws(() => decodeGithubCursor(tampered, { action: action as never, backend: 'github-api', fingerprint: fp }));
      // Fingerprint pin blocks cross-query reuse
      const otherFp = githubCursorFingerprint({ action: action as never, owner: 'other', repo: 'r', limit: 10 });
      assert.throws(() => decodeGithubCursor(cursor, { action: action as never, backend: 'github-api', fingerprint: otherFp }));
      // Forbidden state material rejected at encode
      assert.throws(() =>
        encodeGithubCursor({ action: action as never, backend: 'github-api', fingerprint: fp, state: { token: 'x' } }),
      );
    }
  });
});

describe('property: provider result envelopes fail closed', () => {
  it('valid envelope passes; field deletion/type corruption always fails', () => {
    const good = buildNorthstarResult({
      request: { tool: 'web_search', channel: 'web', action: 'search' },
      outcomes: [
        {
          source: 'openalex',
          backend: 'openalex-api',
          entities: [
            {
              entityVersion: 1,
              kind: 'work',
              id: 'w1',
              source: 'openalex',
              title: 't',
              url: 'https://example.com/w1',
            },
          ],
        },
      ],
      pagination: { supported: true, limit: 10, hasMore: false },
    });
    assert.equal(validateNorthstarResult(good).ok, true);

    for (let i = 0; i < 150; i++) {
      const mutated = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      const op = i % 4;
      if (op === 0) delete (mutated as Record<string, never>)['schema'];
      else if (op === 1) (mutated['pagination'] as Record<string, unknown>)['limit'] = 'ten';
      else if (op === 2) ((mutated['data'] as Record<string, unknown>)['entities'] as unknown[])[0] = { kind: 'work' };
      else ((mutated['errors'] as unknown[]) satisfies unknown[]).push(42);
      assert.equal(validateNorthstarResult(mutated).ok, false, `mutation op ${op} passed validation`);
    }
  });

  it('parseEntity never throws on fuzz; missing id/url always rejected', () => {
    const keys = ['id', 'doi', 'url', 'title', 'authors', 'year', 'metrics', 'snippet'];
    for (let i = 0; i < 150; i++) {
      const row: Record<string, unknown> = {};
      for (const k of keys) {
        const r = rand();
        row[k] = r < 0.3 ? str(5) : r < 0.5 ? 42 : r < 0.6 ? null : r < 0.7 ? [1, 2] : { x: 1 };
      }
      let res;
      assert.doesNotThrow(() => {
        res = parseEntity(row, { source: 'fuzz', kind: 'work' });
      });
      assert.ok(res!.ok === true || res!.ok === false);
      // Missing id+url must fail
      assert.equal(parseEntity({ title: 'x' }, { source: 'fuzz', kind: 'work' }).ok, false);
      // Validated entity with wrong metric types flagged
      const bad = validateNorthstarEntity({ entityVersion: 1, kind: 'work', id: 'a', source: 's', title: 't', url: 'u', metrics: { score: 'high' } });
      assert.equal(bad.ok, false);
    }
  });
});

describe('property: bridge protocol transitions', () => {
  const token = 'tok-' + 'x'.repeat(8);
  const base = { protocol: 1, sessionKey: 's', grantId: 'g', targetInstanceId: 'inst-0001', bridgeToken: token } as const;

  it('command/result parsers round-trip; unknown protocol/kind/code rejected', () => {
    const kinds: Array<Record<string, unknown>> = [
      { kind: 'execute', operation: { kind: 'text' } },
      { kind: 'execute', operation: { kind: 'snapshot', compact: true } },
      { kind: 'execute', operation: { kind: 'wait', waitMs: 500 } },
      { kind: 'revoke' },
      { kind: 'authorize', leaseExpiresAt: 999 },
    ];
    for (let i = 0; i < 100; i++) {
      const extra = pick(kinds);
      const cmd = { ...base, id: `cmd-${i}-${str(4)}`, ...extra };
      const parsed = parseChromeBridgeCommand(cmd);
      assert.equal(parsed.id, cmd.id);
      const okResult = { protocol: 1, id: cmd.id, ok: true, data: { n: i } };
      assert.deepEqual(parseChromeBridgeResult(okResult).id, cmd.id);
      const errResult = {
        protocol: 1,
        id: cmd.id,
        ok: false,
        error: { code: pick(['chrome_timeout', 'chrome_revoked', 'chrome_locked'] as const), message: 'm', retryable: false },
      };
      assert.equal(parseChromeBridgeResult(errResult).ok, false);

      // Fail-closed mutations
      assert.throws(() => parseChromeBridgeCommand({ ...cmd, protocol: 2 }));
      assert.throws(() => parseChromeBridgeCommand({ ...cmd, kind: 'eval' }));
      assert.throws(() => parseChromeBridgeCommand({ ...cmd, id: '' }));
      assert.throws(() => parseChromeBridgeResult({ ...okResult, protocol: 99 }));
      assert.throws(() => parseChromeBridgeResult({ protocol: 1, id: cmd.id, ok: false, error: { code: 'nope', message: 'm', retryable: false } }));
      assert.throws(() => parseChromeProfileOperation({ kind: 'eval', code: 'x' }));
    }
  });

  it('register→command→result→revoke ordering: duplicates and late results withheld', () => {
    const server = new ChromeBridgeServer({ extensionId: 'test-extension-id' });
    for (let i = 0; i < 50; i++) {
      const iid = `inst-${str(8)}`;
      const info = server.registerInstance({ instanceId: iid, family: 'Chrome', version: '1.2.3', caps: '' });
      assert.equal(info.instanceId, iid);
      // Malformed claims rejected
      assert.throws(() => parseBridgeInstanceClaim({ instanceId: 'short', family: 'c', version: '1.2.3', caps: '' }));
      assert.throws(() => parseBridgeInstanceClaim({ instanceId: iid, family: 'c', version: 'bad', caps: '' }));
      assert.throws(() => parseBridgeInstanceClaim({ instanceId: iid, family: 'c', version: '1.2.3', caps: '', protocol: 2 }));

      // Unknown ids are withheld (never resolve as success-after-revoke)
      const unknownId = `never-seen-${i}`;
      assert.equal(server.isWithheld(unknownId), true);
      // Revoke marks id; late result for it is withheld
      const lateId = `cmd-late-${i}`;
      server.revokeCommand(lateId);
      assert.equal(server.isWithheld(lateId), true);
      // Duplicate command shape parses deterministically (server dedupes by id at transport)
      const cmd = { ...base, targetInstanceId: iid, id: `dup-${i}`, kind: 'revoke' as const };
      assert.deepEqual(parseChromeBridgeCommand(cmd), parseChromeBridgeCommand({ ...cmd }));
    }
    // Family stored lowercase; heartbeat on unknown false
    assert.equal(server.heartbeat('no-such-instance'), false);
  });
});

describe('property: runtime RPC envelopes fail closed under mutation', () => {
  const negotiate = { version: 1, requestId: 'req-abc', method: 'negotiate', params: { modelId: 'prov/model' } };
  const okReply = { version: 1, requestId: 'req-abc', method: 'negotiate', success: true, data: { compatible: true } };
  const MUTANTS: Array<(value: Record<string, unknown>) => void> = [
    (v) => { delete v['version']; },
    (v) => { v['version'] = 2; },
    (v) => { v['requestId'] = ''; },
    (v) => { v['requestId'] = 'x'.repeat(129); },
    (v) => { v['requestId'] = 'bad id!'; },
    (v) => { v['method'] = 'eval'; },
    (v) => { v['extra'] = 1; },
    (v) => { v['params'] = { modelId: 'prov/model', injected: true }; },
    (v) => { v['params'] = { modelId: 'no-slash' }; },
    (v) => { v['params'] = { modelId: 'prov/model:high' }; },
  ];
  const REPLY_MUTANTS: Array<(value: Record<string, unknown>) => void> = [
    (v) => { delete v['version']; },
    (v) => { v['version'] = 9; },
    (v) => { v['requestId'] = 'other-id'; },
    (v) => { v['method'] = 'start'; },
    (v) => { v['method'] = 'evil'; },
    (v) => { v['success'] = 'yes'; },
    (v) => { delete v['data']; },
    (v) => { v['smuggled'] = { code: 'x' }; },
  ];
  it('seeded request mutations always rejected', () => {
    assert.equal(validateRequest(negotiate).ok, true);
    for (let i = 0; i < 120; i++) {
      const mutated = JSON.parse(JSON.stringify(negotiate)) as Record<string, unknown>;
      MUTANTS[i % MUTANTS.length]!(mutated);
      assert.equal(validateRequest(mutated).ok, false, `request mutant ${i % MUTANTS.length} passed`);
    }
  });
  it('seeded reply mutations always rejected', () => {
    assert.equal(validateReply(okReply, 'req-abc', 'negotiate').ok, true);
    for (let i = 0; i < 120; i++) {
      const mutated = JSON.parse(JSON.stringify(okReply)) as Record<string, unknown>;
      REPLY_MUTANTS[i % REPLY_MUTANTS.length]!(mutated);
      assert.equal(validateReply(mutated, 'req-abc', 'negotiate').ok, false, `reply mutant ${i % REPLY_MUTANTS.length} passed`);
    }
    // Unknown error codes never validate, whatever the message claims.
    for (let i = 0; i < 20; i++) {
      const forged = {
        version: 1,
        requestId: 'req-abc',
        success: false,
        error: { code: `custom_${str(4)}`, message: 'safe-looking text' },
      };
      assert.equal(validateReply(forged, 'req-abc').ok, false);
    }
  });
});

describe('property: supply-chain hostile inputs inert (installer public API only)', () => {
  // No live installers/network: PATH points at a dead directory so no
  // candidate binary resolves and no child process spawns. Hostile
  // package/version/pin-like strings travel only via the public
  // `channels` selector of runSetupInstall.
  const DEAD_PATH = '/nonexistent-pi-supply-chain-fuzz-path';
  const KNOWN_IDS = new Set([
    'gh',
    'yt-dlp',
    'opencli',
    'twitter-cli',
    'rdt-cli',
    'bili-cli',
    'xhs-cli',
    'mcporter',
  ]);
  const PINNED_SPECS = [
    '@jackwener/opencli@1.8.6',
    'twitter-cli==0.8.5',
    'rdt-cli',
    'bilibili-cli==0.6.2',
    'xhs-cli==0.1.4',
    'mcporter@0.13.12',
  ];
  const HOSTILE = [
    'twitter-cli==9.9.9',
    'twitter-cli==0.8.5; rm -rf /',
    'twitter; echo pwned',
    'twitter|evil',
    '$(evil)',
    '`evil`',
    '--version',
    '-g evil',
    '@jackwener/opencli@9.9.9',
    '..',
    '../../etc/passwd',
    '/etc/passwd',
    '',
    'TWITTER',
    'twitter\nevil',
    'twitter\0evil',
    'xhs-cli==0.1.4 --user',
    'git+https://evil.example/x.git',
    'npm install -g evil',
    '*',
    'opencli@1.8.6;evil',
  ];
  const frand = mulberry32(0x51ab1e);
  const fpick = <T>(arr: readonly T[]): T => arr[Math.floor(frand() * arr.length)]!;

  it('hostile-only channels select nothing; mixed channels keep fixed pins', async () => {
    for (let i = 0; i < 60; i++) {
      const hostileOnly = [fpick(HOSTILE), fpick(HOSTILE)];
      const none = await runSetupInstall('install_channels', { PATH: DEAD_PATH }, hostileOnly);
      assert.equal(none.installAllowed, true);
      assert.deepEqual(none.installers, [], `hostile channels selected installers: ${JSON.stringify(hostileOnly)}`);
      assert.equal(none.status, 'ok');

      const mixed = await runSetupInstall('install_channels', { PATH: DEAD_PATH }, ['twitter', fpick(HOSTILE), fpick(HOSTILE)]);
      const ids = mixed.installers.map((r) => r.id).sort();
      assert.deepEqual(ids, ['opencli', 'twitter-cli']);
      for (const r of mixed.installers) {
        assert.ok(KNOWN_IDS.has(r.id), `unknown installer id: ${r.id}`);
        // Dead PATH: nothing resolvable, so every installer skips with no argv.
        assert.equal(r.status, 'skipped');
        assert.equal(r.command, undefined);
      }
    }
  });

  it('any emitted argv carries only fixed pins; version claims impossible without binaries', async () => {
    for (let i = 0; i < 40; i++) {
      const channels = i % 2 === 0 ? ['twitter', fpick(HOSTILE)] : [fpick(HOSTILE)];
      const result = await runSetupInstall('install_channels', { PATH: DEAD_PATH }, channels);
      for (const r of result.installers) {
        assert.ok(KNOWN_IDS.has(r.id), `unknown installer id: ${r.id}`);
        const status: string = r.status;
        assert.ok(status === 'skipped' || status === 'present', `unexpected status without binaries: ${status}`);
        if (r.command !== undefined) {
          const argv = r.command.join(' ');
          for (const h of ['rm -rf', '$(', '`', ';', '--user', 'evil.example', '9.9.9']) {
            assert.ok(!argv.includes(h), `hostile marker in argv: ${argv}`);
          }
          assert.ok(
            PINNED_SPECS.some((pin) => argv.includes(pin)) || argv.length === 0,
            `argv lost fixed pin: ${argv}`,
          );
        }
        // Exact version format: without binaries nothing may claim installed/present
        // with a version string; skipped carries no version claim.
        if (r.status === 'present' || r.status === 'installed') {
          assert.fail(`version claim without binary: ${r.id} ${r.status} ${r.message}`);
        }
      }
    }
  });
});
