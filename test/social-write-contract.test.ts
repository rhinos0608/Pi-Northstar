import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SOCIAL_WRITE_MATRIX,
  SOCIAL_WRITE_ACTIONS,
  isSocialWriteAction,
  validateSocialWriteRequest,
} from '../src/social-write-contract.js';
import { SOCIAL_PLATFORMS, SocialError } from '../src/social-contract.js';

function writeError(code: string, run: () => unknown): SocialError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}) but nothing was thrown`);
}

test('write vocabulary is exactly create_post/add_comment/like/follow', () => {
  assert.deepEqual([...SOCIAL_WRITE_ACTIONS], ['create_post', 'add_comment', 'like', 'follow']);
  for (const action of SOCIAL_WRITE_ACTIONS) assert.ok(isSocialWriteAction(action));
});

test('delete_post and destructive/legacy spellings are unsupported_action', () => {
  const forbidden = [
    'delete_post',
    'delete_comment',
    'delete',
    'remove',
    'destroy',
    'purge',
    'delete_account',
    'post',
    'comment',
    'read',
    'search',
    'get_post',
    'tweet',
    'submit',
    'publish',
    'create',
    '',
  ];
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of forbidden) {
      const error = writeError('unsupported_action', () =>
        validateSocialWriteRequest({ platform, action, payload: { text: 'hi' } }),
      );
      assert.ok(!error.message.includes('hi'), 'no payload echo');
    }
  }
  assert.ok(!isSocialWriteAction('delete_post'));
});

test('default matrix disallows every platform', () => {
  for (const platform of SOCIAL_PLATFORMS) {
    assert.deepEqual([...DEFAULT_SOCIAL_WRITE_MATRIX[platform]], []);
  }
});

test('create_post requires payload text, rejects without echo', () => {
  const { request } = validateSocialWriteRequest({
    platform: 'reddit',
    action: 'create_post',
    payload: { text: 'hello world' },
  });
  assert.equal(request.text, 'hello world');
  const secret = `SECRET-${'x'.repeat(100)}`;
  const error = writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'reddit', action: 'create_post', payload: { text: '' } }),
  );
  assert.ok(!error.message.includes(secret.slice(0, 10)));
  writeError('invalid_request', () => validateSocialWriteRequest({ platform: 'reddit', action: 'create_post' }));
  assert.ok(secret.length > 0);
  // oversized payload rejected, never echoed
  const big = writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'reddit', action: 'create_post', payload: { text: 'y'.repeat(5001) } }),
  );
  assert.ok(!big.message.includes('yyy'));
});

test('add_comment requires postId + text; like requires postId only; follow requires user only', () => {
  validateSocialWriteRequest({ platform: 'twitter', action: 'add_comment', postId: 'p1', payload: { text: 'nice' } });
  writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'twitter', action: 'add_comment', payload: { text: 'nice' } }),
  );
  validateSocialWriteRequest({ platform: 'twitter', action: 'like', postId: 'p1' });
  writeError('invalid_request', () => validateSocialWriteRequest({ platform: 'twitter', action: 'like' }));
  writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'twitter', action: 'like', postId: 'p1', payload: { text: 'x' } }),
  );
  validateSocialWriteRequest({ platform: 'twitter', action: 'follow', user: 'someone' });
  writeError('invalid_request', () => validateSocialWriteRequest({ platform: 'twitter', action: 'follow' }));
  writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'twitter', action: 'follow', user: 'someone', payload: { text: 'x' } }),
  );
});

test('selector echoes capped at 32 chars; payload never echoed', () => {
  const longUser = `u-${'A'.repeat(2000)}`;
  const error = writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'nope-platform', action: 'follow', user: longUser }),
  );
  assert.ok(!error.message.includes('A'.repeat(33)));
  const payloadSecret = `PW-${'B'.repeat(6000)}`;
  const error2 = writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'reddit', action: 'create_post', payload: { text: payloadSecret } }),
  );
  assert.ok(!error2.message.includes('B'.repeat(33)));
  // empty-string selector rejected, not clamped
  writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'twitter', action: 'follow', user: '   ' }),
  );
  // oversized selector rejected
  writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'twitter', action: 'follow', user: 'z'.repeat(1025) }),
  );
  // non-object payload and unknown payload fields rejected
  writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'reddit', action: 'create_post', payload: 'hi' }),
  );
  writeError('invalid_request', () =>
    validateSocialWriteRequest({ platform: 'reddit', action: 'create_post', payload: { text: 'hi', extra: 1 } }),
  );
});

test('unknown platform rejected', () => {
  writeError('invalid_request', () => validateSocialWriteRequest({ platform: 'tiktok', action: 'like' }));
});
