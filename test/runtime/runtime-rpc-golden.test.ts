import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBrokerFrame, encodeBrokerFrame } from '../../src/runtime/broker-protocol.js';
import { validateRequest, validateReply } from '../../src/runtime/runtime-rpc-protocol.js';
import { brokerEndpoint } from '../../src/runtime/broker-endpoint.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/rpc-golden', import.meta.url));

test('rpc golden fixtures validate according to prefix contract', async () => {
  const files = await readdir(FIXTURES_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
  assert.ok(jsonFiles.length > 0, 'expected at least one golden fixture');

  for (const file of jsonFiles) {
    const fullPath = join(FIXTURES_DIR, file);
    const text = await readFile(fullPath, 'utf8');
    const parsed: unknown = JSON.parse(text);

    if (file.startsWith('broker-v2-')) {
      const decoded = decodeBrokerFrame(encodeBrokerFrame(parsed as any));
      assert.deepEqual(decoded, parsed, `fixture ${file} must round-trip via encode/decodeBrokerFrame`);
    } else if (file.startsWith('rpc-v1-request-')) {
      const res = validateRequest(parsed);
      assert.equal(res.ok, true, `fixture ${file} must validate as valid rpc-v1 request`);
    } else if (file.startsWith('rpc-v1-reply-')) {
      const res = validateReply(parsed);
      assert.equal(res.ok, true, `fixture ${file} must validate as valid rpc-v1 reply`);
    } else {
      assert.fail(`fixture ${file} has unrecognized prefix`);
    }
  }
});

test('broker-endpoint no longer exports secretPath', () => {
  const endpoint = brokerEndpoint('test-project');
  assert.equal('secretPath' in endpoint, false, 'brokerEndpoint result should not have secretPath property');
});
