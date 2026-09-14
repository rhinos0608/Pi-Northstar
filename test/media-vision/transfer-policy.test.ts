import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mayTransferPrivateGithubToVision,
  PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR,
  resolveVisionTransfer,
  VISION_PRIVATE_TRANSFER_WARNING,
  VISION_PUBLIC_TRANSFER_WARNING,
} from '../../src/media-vision/transfer-policy.js';

describe('private transfer gate', () => {
  it('requires the exact value "1", default off', () => {
    assert.equal(mayTransferPrivateGithubToVision({}), false);
    assert.equal(mayTransferPrivateGithubToVision({ [PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR]: '1' }), true);
    assert.equal(mayTransferPrivateGithubToVision({ [PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR]: 'true' }), false);
    assert.equal(mayTransferPrivateGithubToVision({ [PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR]: '' }), false);
  });

  it('private github content never reaches cloud without the flag', () => {
    const denied = resolveVisionTransfer({
      contentKind: 'private-github',
      destinationConfigured: true,
      env: {},
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'private_vision_transfer_not_opted_in');
  });

  it('private github content transfers only with flag plus configured destination', () => {
    const allowed = resolveVisionTransfer({
      contentKind: 'private-github',
      destinationConfigured: true,
      env: { [PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR]: '1' },
    });
    assert.equal(allowed.allowed, true);
  });
});

describe('public transfer + cross-provider leakage', () => {
  it('public content needs an explicitly configured destination', () => {
    assert.equal(
      resolveVisionTransfer({ contentKind: 'public', destinationConfigured: false }).allowed,
      false,
    );
    assert.equal(
      resolveVisionTransfer({ contentKind: 'public', destinationConfigured: true }).allowed,
      true,
    );
  });

  it('one configured destination never authorizes another (per-destination input)', () => {
    const first = resolveVisionTransfer({
      contentKind: 'public',
      destinationConfigured: true,
    });
    const second = resolveVisionTransfer({
      contentKind: 'public',
      destinationConfigured: false,
    });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false);
    assert.equal(second.reason, 'vision_destination_unconfigured');
  });

  it('flag alone does not authorize an unconfigured destination', () => {
    const result = resolveVisionTransfer({
      contentKind: 'private-github',
      destinationConfigured: false,
      env: { [PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR]: '1' },
    });
    assert.equal(result.allowed, false);
  });
});

describe('warning strings', () => {
  it('state what leaves the machine and require explicit opt-in', () => {
    assert.match(VISION_PUBLIC_TRANSFER_WARNING, /leaves the machine/i);
    assert.match(VISION_PUBLIC_TRANSFER_WARNING, /explicitly opts in/i);
    assert.match(VISION_PRIVATE_TRANSFER_WARNING, /PI_VISION_PRIVATE_GITHUB_TRANSFER/);
    assert.match(VISION_PRIVATE_TRANSFER_WARNING, /never reach/i);
  });
});
