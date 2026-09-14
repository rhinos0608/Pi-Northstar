import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetBudgetLedger } from '../../src/assets/budget-ledger.js';
import { AGGREGATE_MAX_BYTES } from '../../src/assets/asset-contract.js';
import { GITHUB_BACKEND_PREFERENCE } from '../../src/github/github-contract.js';
// Seam-name agreement with the W-E1 clone backend (owner: github-clone.ts).
// This import only names the seam; routing itself filters by availability.
import { GITHUB_CLONE_BACKEND } from '../../src/github/github-clone.js';
import {
  assertPrivateGithubVisionTransfer,
  isGithubCloneBackendAvailable,
  reserveGithubAcquisitionBudget,
  resolveGithubBackendChain,
} from '../../src/github/github-domain.js';
import { PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR } from '../../src/media-vision/transfer-policy.js';
import { SocialError } from '../../src/social/social-contract.js';

const TOKEN = 'secret-token-xyz';

// ── Transfer-flag assertion (Plan D gate, read-only) ──

test('private transfer without opt-in rejects, names the env var, leaks nothing', () => {
  try {
    assertPrivateGithubVisionTransfer({ GITHUB_TOKEN: TOKEN });
    throw new Error('expected authentication_required, but nothing threw');
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, 'authentication_required');
    assert.ok(error.message.includes(PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR), 'must name the opt-in var');
    assert.equal(PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR, 'PI_VISION_PRIVATE_GITHUB_TRANSFER');
    assert.ok(!error.message.includes(TOKEN), 'token leaked into error');
  }
});

test('private transfer passes only on exact opt-in value "1"', () => {
  assertPrivateGithubVisionTransfer({ [PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR]: '1', GITHUB_TOKEN: TOKEN });
  for (const denied of [undefined, '', '0', 'true', 'yes', ' 1 ']) {
    assert.throws(
      () => assertPrivateGithubVisionTransfer(
        denied === undefined ? {} : { [PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR]: denied },
      ),
      /private transfer denied/,
    );
  }
});

// ── 512MiB ledger enforcement (Plan B gate, read-only) ──

test('ledger reserves within budget and rejects beyond 512MiB as upstream_error', () => {
  assert.equal(AGGREGATE_MAX_BYTES, 512 * 1024 * 1024);
  const ledger = new AssetBudgetLedger();
  reserveGithubAcquisitionBudget(ledger, 1024);
  assert.equal(ledger.used, 1024);
  try {
    reserveGithubAcquisitionBudget(ledger, AGGREGATE_MAX_BYTES);
    throw new Error('expected upstream_error, but nothing threw');
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, 'upstream_error');
    assert.match(error.message, /512MiB/);
    assert.ok(error.cause instanceof Error, 'ledger cause preserved for diagnosis');
  }
  // Failed reservation pins nothing: released budget is reusable.
  ledger.release(1024);
  assert.equal(ledger.used, 0);
  reserveGithubAcquisitionBudget(ledger, 2048);
  assert.equal(ledger.used, 2048);
});

// ── Domain routing (Plan E3, W-E1 seam mocked by availability) ──

test('routing agrees with the W-E1 seam name and prefers clone-first for repo/tree', () => {
  assert.equal(GITHUB_CLONE_BACKEND, 'github-clone');
  assert.equal(GITHUB_BACKEND_PREFERENCE.repo[0], GITHUB_CLONE_BACKEND);
  assert.equal(GITHUB_BACKEND_PREFERENCE.tree[0], GITHUB_CLONE_BACKEND);
  assert.deepEqual(resolveGithubBackendChain('repo', ['github-api', GITHUB_CLONE_BACKEND]), [
    GITHUB_CLONE_BACKEND,
    'github-api',
  ]);
  assert.deepEqual(resolveGithubBackendChain('tree', ['github-api', GITHUB_CLONE_BACKEND]), [
    GITHUB_CLONE_BACKEND,
    'github-api',
  ]);
});

test('routing prefers REST-first for file and drops unknown backends', () => {
  assert.deepEqual(resolveGithubBackendChain('file', ['github-clone', 'github-api']), [
    'github-api',
    'github-clone',
  ]);
  assert.deepEqual(resolveGithubBackendChain('repo', ['github-api', 'nope']), ['github-api']);
  assert.deepEqual(resolveGithubBackendChain('repo', []), []);
});

test('registered clone executor is available; default chain stays REST-first', () => {
  // W-E1 landed: the executor is registered, so the seam reports available
  // and repo/tree resolve clone-first when the clone backend is offered.
  assert.equal(isGithubCloneBackendAvailable(), true);
  assert.deepEqual(resolveGithubBackendChain('repo', ['github-clone', 'github-api']), ['github-clone', 'github-api']);
  assert.deepEqual(resolveGithubBackendChain('tree', ['github-clone', 'github-api']), ['github-clone', 'github-api']);
  assert.deepEqual(resolveGithubBackendChain('repo'), ['github-api']);
  assert.deepEqual(resolveGithubBackendChain('tree'), ['github-api']);
  assert.deepEqual(resolveGithubBackendChain('file'), ['github-api']);
});
