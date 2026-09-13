import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompanionEntry } from '../../src/chrome/chrome-companion-registry.js';
import { selectCompanion } from '../../src/chrome/chrome-companion-selection.js';

function entry(instanceId: string, family: CompanionEntry['family']): CompanionEntry {
  return { instanceId, family, version: '1', evidence: 'e', lastSeen: 1 };
}

test('chromium default selects sole family match; missing/ambiguous fail', () => {
  const ok = selectCompanion({
    osDefault: { family: 'chrome', isChromium: true },
    companions: [entry('a', 'chrome'), entry('b', 'edge')],
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.selected.instanceId, 'a');

  const missing = selectCompanion({ osDefault: { family: 'brave', isChromium: true }, companions: [entry('a', 'chrome')] });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.kind, 'missing');

  const ambiguous = selectCompanion({
    osDefault: { family: 'chrome', isChromium: true },
    companions: [entry('a', 'chrome'), entry('b', 'chrome')],
  });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.kind, 'ambiguous');
});

test('non-chromium/unknown requires explicit choice; headless guidance', () => {
  const need = selectCompanion({ osDefault: { family: 'safari', isChromium: false }, companions: [entry('a', 'chrome')] });
  assert.equal(need.ok, false);
  if (!need.ok) assert.equal(need.kind, 'explicit-required');

  const headless = selectCompanion({ osDefault: null, companions: [entry('a', 'chrome')], headless: true });
  assert.equal(headless.ok, false);
  if (!headless.ok) assert.match(headless.message, /headless/);

  const explicit = selectCompanion({
    osDefault: { family: 'safari', isChromium: false },
    companions: [entry('a', 'chrome'), entry('b', 'edge')],
    explicitFamily: 'edge',
  });
  assert.equal(explicit.ok, true);

  const dup = selectCompanion({
    osDefault: { family: 'chrome', isChromium: true },
    companions: [entry('a', 'edge'), entry('b', 'edge')],
    explicitFamily: 'edge',
  });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.kind, 'explicit-ambiguous');
});
