import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwner, brokerEndpoint, removeStaleEndpoint } from '../../src/runtime/broker-endpoint.js';

test('stale endpoint refuses symlink deletion', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-broker-'));
  const endpoint = brokerEndpoint('project', root);
  await import('node:fs/promises').then(fs => fs.mkdir(endpoint.rootDir, { mode: 0o700 }));
  const target = join(root, 'target');
  await writeFile(target, 'keep');
  await symlink(target, endpoint.socketPath);
  assert.equal(await removeStaleEndpoint(endpoint), false);
});

test('assertOwner rejects symlinked paths', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-broker-'));
  const target = join(root, 'target');
  const link = join(root, 'link');
  await writeFile(target, 'keep');
  await symlink(target, link);
  await assert.rejects(assertOwner(link), /endpoint_unsafe/);
});

test('runtime directory mode is enforced before stale cleanup', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-broker-'));
  const endpoint = brokerEndpoint('project', root);
  await import('node:fs/promises').then(fs => fs.mkdir(endpoint.rootDir, { mode: 0o700 }));
  await chmod(endpoint.rootDir, 0o755);
  await assert.rejects(removeStaleEndpoint(endpoint), /endpoint_unsafe/);
});
