import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_GRAPH_ONTOLOGY_CACHE_PATH,
  readOntologyCacheFile,
  writeOntologyCacheFileAtomic,
  ontologyCacheFresh,
  GRAPH_ONTOLOGY_TTL_MS,
} from '../src/graph-schema-cache.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'graph-cache-test-'));
}

test('default cache path lives under ~/.pi-northstar/cache', () => {
  assert.ok(DEFAULT_GRAPH_ONTOLOGY_CACHE_PATH.endsWith(join('.pi-northstar', 'cache', 'diffbot-ontology-v1.json')));
});

test('fresh cache reads back with fetchedAt', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'nested', 'diffbot-ontology-v1.json');
    const payload = { fetchedAt: new Date().toISOString(), ontology: { metadata: {}, types: { Person: { name: 'Person' } } } };
    await writeOntologyCacheFileAtomic(path, payload);
    const read = await readOntologyCacheFile(path);
    assert.equal(read.ok, true);
    assert.equal(ontologyCacheFresh(read.payload?.fetchedAt, Date.now()), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale cache detected after 24h TTL', () => {
  assert.equal(GRAPH_ONTOLOGY_TTL_MS, 24 * 60 * 60 * 1000);
  const old = new Date(Date.now() - GRAPH_ONTOLOGY_TTL_MS - 1000).toISOString();
  assert.equal(ontologyCacheFresh(old, Date.now()), false);
  assert.equal(ontologyCacheFresh(new Date().toISOString(), Date.now()), true);
  assert.equal(ontologyCacheFresh(undefined, Date.now()), false);
  assert.equal(ontologyCacheFresh('not-a-date', Date.now()), false);
});

test('malformed cache rejected, never trusted', async () => {
  const dir = tempDir();
  try {
    const { writeFileSync } = await import('node:fs');
    const path = join(dir, 'cache.json');
    writeFileSync(path, '{not json');
    assert.equal((await readOntologyCacheFile(path)).ok, false);
    writeFileSync(path, JSON.stringify({ nope: true }));
    assert.equal((await readOntologyCacheFile(path)).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing cache returns not-found without throwing', async () => {
  const read = await readOntologyCacheFile(join(tempDir(), 'does-not-exist.json'));
  assert.equal(read.ok, false);
  assert.equal(read.malformed, false);
});
