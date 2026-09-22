import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOsQueryEnv,
  detectOsDefault,
  isChromiumFamily,
  listOsDefaultQueries,
  OS_DEFAULT_EVIDENCE_MAX_CHARS,
} from '../../src/chrome/chrome-os-default.js';

test('query allowlist fixed per platform; unknown platform empty', () => {
  assert.ok(listOsDefaultQueries('darwin').length >= 1);
  assert.ok(listOsDefaultQueries('linux').length >= 1);
  assert.ok(listOsDefaultQueries('win32').length >= 1);
  assert.deepEqual(listOsDefaultQueries('sunos' as NodeJS.Platform), []);
  for (const q of [...listOsDefaultQueries('darwin'), ...listOsDefaultQueries('linux')]) {
    assert.ok(q.argv[0]!.startsWith('/'));
    assert.ok(q.label.length > 0);
  }
});

test('sanitized env drops secrets', () => {
  const env = buildOsQueryEnv({ PATH: '/usr/bin', API_KEY: 's3cret', PI_TOKEN: 't', LANG: 'en_US.UTF-8' } as Record<string, string>);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.PI_TOKEN, undefined);
});

test('chromium default detected from fixed query output', () => {
  const out = detectOsDefault({
    platform: 'linux',
    run: (q) => (q.label.includes('xdg-default') ? 'google-chrome.desktop\n' : null),
  });
  assert.ok(out !== null && out.family === 'chrome' && out.isChromium);
  assert.ok(out.evidence.length <= OS_DEFAULT_EVIDENCE_MAX_CHARS);
});

test('macOS LaunchServices parsing ignores installed non-default browsers', () => {
  const launchServices = `(
    {
      LSHandlerRoleAll = "com.brave.Browser";
      LSHandlerContentType = "public.html";
    },
    {
      LSHandlerRoleAll = "com.apple.Safari";
      LSHandlerURLScheme = http;
    },
    {
      LSHandlerRoleAll = "com.google.Chrome";
      LSHandlerURLScheme = ftp;
    }
  )`;
  const out = detectOsDefault({ platform: 'darwin', run: () => launchServices });
  assert.equal(out?.family, 'safari');
  assert.equal(out?.isChromium, false);
});

test('macOS default-family parser recognizes Arc bundle id and prefers http over https fallback', () => {
  const launchServices = `(
    {
      LSHandlerRoleAll = "com.google.Chrome";
      LSHandlerURLScheme = https;
    },
    {
      LSHandlerRoleAll = "company.thebrowser.Browser";
      LSHandlerURLScheme = http;
    }
  )`;
  const out = detectOsDefault({ platform: 'darwin', run: () => launchServices });
  assert.equal(out?.family, 'arc');
  assert.equal(out?.isChromium, true);
});

test('non-chromium default flagged; unknown misses return null', () => {
  const safari = detectOsDefault({ platform: 'darwin', run: () => 'com.apple.safari' });
  assert.ok(safari !== null && safari.family === 'safari' && !safari.isChromium);
  assert.ok(!isChromiumFamily('safari'));
  const miss = detectOsDefault({ platform: 'linux', run: () => 'some-unknown-handler' });
  assert.equal(miss, null);
  const throwing = detectOsDefault({ platform: 'linux', run: () => { throw new Error('boom'); } });
  assert.equal(throwing, null);
});
