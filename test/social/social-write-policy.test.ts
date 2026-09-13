import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SOCIAL_PLATFORMS } from '../../src/social/social-contract.js';
import { SOCIAL_WRITE_ACTIONS } from '../../src/social/social-write-contract.js';
import {
  clearSocialWriteAuditLog,
  getSocialWriteAuditLog,
  isDeniedSocialWrite,
  setSocialWriteAuditWriter,
  socialWriteEnabled,
  trySocialWrite,
  validateSocialWrite,
  type SocialWriteAuditEntry,
} from '../../src/social/social-write-policy.js';

const ENABLED = { PI_SEARCH_SOCIAL_WRITE: '1' };
const DISABLED: Record<string, string | undefined> = {};

function validInput(platform: string, action: string): Record<string, unknown> {
  switch (action) {
    case 'create_post':
      return { platform, action, payload: { text: 'hello preview' } };
    case 'add_comment':
      return { platform, action, postId: 'p1', payload: { text: 'nice post' } };
    case 'like':
      return { platform, action, postId: 'p1' };
    case 'follow':
      return { platform, action, user: 'someone' };
    default:
      return { platform, action };
  }
}

test('kill switch: unset/empty/other values deny; only exact 1 enables', () => {
  assert.equal(socialWriteEnabled({}), false);
  assert.equal(socialWriteEnabled(DISABLED), false);
  assert.equal(socialWriteEnabled({ PI_SEARCH_SOCIAL_WRITE: '' }), false);
  assert.equal(socialWriteEnabled({ PI_SEARCH_SOCIAL_WRITE: 'true' }), false);
  assert.equal(socialWriteEnabled({ PI_SEARCH_SOCIAL_WRITE: '0' }), false);
  assert.equal(socialWriteEnabled(ENABLED), true);
});

test('default-deny: every platform+action denied with kill switch unset', () => {
  clearSocialWriteAuditLog();
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of SOCIAL_WRITE_ACTIONS) {
      const result = trySocialWrite(validInput(platform, action) as never, {});
      assert.equal(result.status, 'denied');
      assert.equal(result.reason, 'social_write_disabled');
      assert.equal(result.preview, undefined);
    }
  }
});

test('default-deny: legacy/destructive spellings denied', () => {
  const legacy = ['delete_post', 'delete', 'post', 'search', 'get_post', 'tweet', 'submit', 'publish'];
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of legacy) {
      const result = trySocialWrite({ platform, action, payload: { text: 'x' } } as never, {});
      assert.equal(result.status, 'denied');
    }
  }
});

test('kill switch =1 with empty allowlist still denied (never dry_run)', () => {
  clearSocialWriteAuditLog();
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of SOCIAL_WRITE_ACTIONS) {
      const result = trySocialWrite(validInput(platform, action) as never, ENABLED);
      assert.equal(result.status, 'denied');
      assert.equal(result.reason, 'social_write_denied');
    }
  }
});

test('isDeniedSocialWrite deny-by-default; explicit matrix allows listed action', () => {
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of SOCIAL_WRITE_ACTIONS) {
      assert.equal(isDeniedSocialWrite(platform, action), true);
    }
  }
  const allowLike = { twitter: ['like' as const], reddit: [], xiaohongshu: [], facebook: [], instagram: [], v2ex: [], linkedin: [] } as const;
  assert.equal(isDeniedSocialWrite('twitter', 'like', allowLike as never), false);
  assert.equal(isDeniedSocialWrite('twitter', 'follow', allowLike as never), true);
});

test('validation success always returns dry_run preview, zero side effects', () => {
  clearSocialWriteAuditLog();
  const matrix = {
    twitter: ['like'],
    reddit: [],
    xiaohongshu: [],
    facebook: [],
    instagram: [],
    v2ex: [],
    linkedin: [],
  } as const;
  const result = trySocialWrite({ platform: 'twitter', action: 'like', postId: 'p1' } as never, ENABLED, {
    matrix: matrix as never,
  });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.reason, 'dry_run_preview');
  assert.equal(result.preview?.platform, 'twitter');
  assert.equal(result.preview?.action, 'like');
  assert.equal(result.preview?.target, 'p1');
  assert.ok(!('text' in (result.preview ?? {})));
  assert.equal(result.preview?.textLength, 0);
  // Stage 8 has no dispatch path and no dryRun opt-out: preview only.
});

test('deny path caps platform/action echo at 32 chars in detail and audit', () => {
  clearSocialWriteAuditLog();
  const longPlatform = `P${'x'.repeat(79)}`;
  const longAction = `A${'y'.repeat(79)}`;
  assert.throws(
    () => validateSocialWrite({ platform: longPlatform, action: longAction } as never, ENABLED),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(!message.includes(longPlatform), 'full platform echo leaked into detail');
      assert.ok(!message.includes(longAction), 'full action echo leaked into detail');
      assert.ok(message.includes(longPlatform.slice(0, 32)), 'capped platform echo present');
      assert.ok(message.includes(longAction.slice(0, 32)), 'capped action echo present');
      return true;
    },
  );
  const log = getSocialWriteAuditLog();
  assert.equal(log.length, 1);
  assert.ok((log[0]?.platform.length ?? 0) <= 32);
  assert.ok((log[0]?.action.length ?? 0) <= 32);
  assert.equal(log[0]?.platform, longPlatform.slice(0, 32));
  assert.equal(log[0]?.action, longAction.slice(0, 32));
  clearSocialWriteAuditLog();
});

test('audit log is a capped ring buffer: newest retained, order preserved', () => {
  clearSocialWriteAuditLog();
  const total = 1005;
  const cap = 1000;
  for (let i = 0; i < total; i++) {
    trySocialWrite({ platform: 'twitter', action: `act-${i}` } as never, {});
  }
  const log = getSocialWriteAuditLog();
  assert.equal(log.length, cap);
  assert.equal(log[0]?.action, 'act-5');
  assert.equal(log[cap - 1]?.action, `act-${total - 1}`);
  clearSocialWriteAuditLog();
});

test('validateSocialWrite re-checks kill switch internally (defense-in-depth)', () => {
  clearSocialWriteAuditLog();
  assert.throws(() => validateSocialWrite({ platform: 'twitter', action: 'like', postId: 'p1' } as never, {}), /social_write_disabled/);
  assert.throws(
    () => validateSocialWrite({ platform: 'twitter', action: 'like', postId: 'p1' } as never, ENABLED),
    /social_write_denied/,
  );
});

test('payload echo never appears in gate errors; invalid input denied', () => {
  clearSocialWriteAuditLog();
  const secret = `TOPSECRET-${'Q'.repeat(80)}`;
  const result = trySocialWrite(
    { platform: 'twitter', action: 'like', postId: 'p1', payload: { text: secret } } as never,
    ENABLED,
    { matrix: { twitter: ['like'], reddit: [], xiaohongshu: [], facebook: [], instagram: [], v2ex: [], linkedin: [] } as never },
  );
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'social_write_invalid');
});

test('audit hook receives denied attempts (in-memory + injectable)', () => {
  clearSocialWriteAuditLog();
  const seen: SocialWriteAuditEntry[] = [];
  setSocialWriteAuditWriter({ record: (entry) => seen.push(entry) });
  try {
    trySocialWrite({ platform: 'reddit', action: 'like', postId: 'p1' } as never, {});
    trySocialWrite({ platform: 'reddit', action: 'like', postId: 'p1' } as never, ENABLED);
  } finally {
    setSocialWriteAuditWriter(undefined);
  }
  const log = getSocialWriteAuditLog();
  assert.ok(log.length >= 2);
  assert.ok(log.every((entry) => entry.status === 'denied'));
  assert.ok(seen.length >= 2, 'injectable writer received entries');
  assert.ok(seen[0]?.reason.length !== 0);
  // append-only: dry_run also audited
  clearSocialWriteAuditLog();
});

test('no network/exec imports in boundary files', () => {
  const contractSrc = readFileSync(new URL('../../src/social/social-write-contract.ts', import.meta.url), 'utf8');
  const policySrc = readFileSync(new URL('../../src/social/social-write-policy.ts', import.meta.url), 'utf8');
  const banned = [
    'node:child_process',
    'node:net',
    'node:http',
    'child_process',
    'execSync',
    'spawn',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'node:fetch',
    'undici',
  ];
  for (const token of banned) {
    assert.ok(!contractSrc.includes(token), `contract contains ${token}`);
    assert.ok(!policySrc.includes(token), `policy contains ${token}`);
  }
  assert.ok(!contractSrc.includes('node:'));
  assert.ok(!policySrc.includes('node:fs'));
  assert.ok(!policySrc.includes('node:child_process'));
  assert.ok(policySrc.includes("from './social-contract.js'"));
  assert.ok(policySrc.includes("from './social-write-contract.js'"));
});
