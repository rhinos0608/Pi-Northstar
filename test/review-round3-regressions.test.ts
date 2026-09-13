import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createWebAccessContentStore, buildWebAccessStoredEntry } from '../src/web/access/web-access-content-store.js';
import { retrieveWebAccessCorpus } from '../src/web/access/web-access-retrieve.js';
import { validateWebRequest } from '../src/web/web-contract.js';
import { selectCompanion, type SelectCompanionInput } from '../src/chrome/chrome-companion-selection.js';
import { PROVIDER_DESCRIPTOR_SOURCE } from '../src/setup/providers.js';
import { cacheWebSearchForRetrieve } from '../src/native-tools.js';

describe('review round3 regressions', () => {
  test('provider docs name real native-AI gates', () => {
    const text = PROVIDER_DESCRIPTOR_SOURCE.map((d) => d.setup).join('\n');
    assert.ok(!text.includes('PI_SEARCH_WEB_NATIVE_AI'));
    assert.ok(text.includes('PI_SEARCH_NATIVE_ANSWERS'));
  });

  test('findText owner attribution is boundary-aware (s-0-1 vs s-0-10)', () => {
    const store = createWebAccessContentStore();
    const results = [{
      queryIndex: 0,
      query: 'q',
      response: {
        provider: 'brave' as const,
        results: Array.from({ length: 11 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}`, snippet: `snip${i}` })),
      },
    }];
    const entry = buildWebAccessStoredEntry({ queries: ['q'], results });
    store.put(entry);
    // Needle lives inside the s-0-10 block; excerpt window also contains s-0-1 marker text.
    const out = retrieveWebAccessCorpus(store, { responseId: entry.responseId, findText: 'snip10' });
    assert.ok(out.matches && out.matches.length > 0);
    assert.equal(out.matches[0]!.sourceId, 's-0-10');
  });

  test('research category rejects batch queries', () => {
    assert.throws(
      () => validateWebRequest({ action: 'search', queries: ['a', 'b'], category: 'research' } as never),
      /queries batch is not supported with category "research"/,
    );
  });

  test('cached corpus preserves raw backend instead of mapping to parallel', async () => {
    const { populateCliCorpus, tryServeCliCorpusAction } = await import('../src/cli/cli-backend.js');
    const store = createWebAccessContentStore();
    const result = populateCliCorpus(store, 'web_search', {
      content: [{ type: 'text', text: 'hits' }],
      details: { query: 'q', results: [{ title: 't', url: 'https://e.com', snippet: 's', backend: 'nope' }] },
    });
    const responseId = (result.details as { responseId: string }).responseId;
    const served = tryServeCliCorpusAction(store, { action: 'retrieve', responseId });
    assert.ok(served !== undefined);
    const sources = (served.details as { sources: Array<{ provider: string }> }).sources;
    assert.equal(sources[0]!.provider, 'nope');
    assert.notEqual(sources[0]!.provider, 'parallel', 'unknown backend must not map to parallel');
    const id = cacheWebSearchForRetrieve('q', [{ title: 't', url: 'https://e.com', snippet: 's', backend: 'nope' }]);
    assert.ok(typeof id === 'string');
  });

  test('same-family duplicate companions fail closed', () => {
    const at = Date.now();
    const input: SelectCompanionInput = {
      osDefault: { family: 'chrome', isChromium: true },
      companions: [
        { family: 'chrome', version: '1.0.0', evidence: '', instanceId: 'i-1', lastSeen: at },
        { family: 'chrome', version: '1.0.0', evidence: '', instanceId: 'i-2', lastSeen: at },
      ],
    };
    const r = selectCompanion(input);
    assert.equal(r.ok, false);
  });

  test('companion navigate uses per-tab DNR base matching cleanup', () => {
    const src = readFileSync(new URL('../chrome-extension/service_worker.js', import.meta.url), 'utf8');
    const sandbox: Record<string, unknown> = { console, Date, Math, JSON, Object, Array, String, Number, Promise };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'service_worker.js' });
    const companion = sandbox.__atlasCompanion as {
      ruleBaseForTab: (tabId: number) => number;
      buildDnrRules: (host: string, tabId: number, base: number) => Array<{ id: number; action: unknown; condition: unknown }>;
    };
    const baseA = companion.ruleBaseForTab(11);
    const baseB = companion.ruleBaseForTab(12);
    assert.notEqual(baseA, baseB, 'distinct tabs map to distinct DNR bases');
    assert.equal(companion.ruleBaseForTab(11), baseA, 'same tab reuses its base');
    const rules = companion.buildDnrRules('example.com', 11, baseA);
    const ids = rules.map((r) => r.id);
    assert.ok(ids.includes(baseA), 'deny rule uses per-tab base');
    assert.ok(ids.includes(baseA + 1), 'allow rule uses per-tab base + 1');
  });
});
