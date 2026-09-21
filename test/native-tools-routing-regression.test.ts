import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import type { DnsLookup } from '../src/network-policy.js';

const lookupCalls: string[] = [];
const lookup: DnsLookup = async (hostname) => {
  lookupCalls.push(hostname);
  return [{ address: '104.18.0.1', family: 4 }];
};

test('native research command handlers forward lookup into all research adapters', async () => {
  lookupCalls.length = 0;
  await callNativeTool('research', { action: 'search', query: 'q', source: 'wikipedia' }, { lookup, env: {} });
  await callNativeTool('research', { action: 'paper', id: 'W123', source: 'openalex' }, { lookup, env: {} });
  await callNativeTool('research', { action: 'citations', id: 'W123', source: 'openalex' }, { lookup, env: {} });
  assert.ok(lookupCalls.length >= 3, `expected lookup for each adapter, got ${lookupCalls.length}`);
});

test('resolved migrated research handler errors do not fall through to legacy dispatch', async () => {
  await assert.rejects(
    () => callNativeTool('research', { action: 'paper' }, { env: {} }),
    (error: unknown) => error instanceof Error && error.message === 'ID or URL is required',
  );
});
