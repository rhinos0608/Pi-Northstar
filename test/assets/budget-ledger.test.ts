import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGGREGATE_MAX_BYTES } from '../../src/assets/asset-contract.js';
import {
  PREFLIGHT_MAX_INPUT_TOKENS_AGGREGATE,
  PREFLIGHT_MAX_INPUT_TOKENS_PER_ASSET,
  AssetBudgetLedger,
  BudgetLedgerError,
  checkTokenPreflight,
  enforcePreflightTokens,
  resolvePreflightTier,
} from '../../src/assets/budget-ledger.js';

test('concurrent acquires in one fetch exceeding 512MiB reject', () => {
  const ledger = new AssetBudgetLedger();
  ledger.reserve(300 * 1024 * 1024);
  assert.throws(() => ledger.reserve(AGGREGATE_MAX_BYTES), BudgetLedgerError);
  assert.equal(ledger.used, 300 * 1024 * 1024);
  // Exact fit admits.
  ledger.reserve(AGGREGATE_MAX_BYTES - 300 * 1024 * 1024);
  assert.equal(ledger.remaining, 0);
});

test('release frees budget for failed acquires', () => {
  const ledger = new AssetBudgetLedger();
  ledger.reserve(100);
  ledger.release(100);
  assert.equal(ledger.used, 0);
  ledger.release(50);
  assert.equal(ledger.used, 0);
  assert.throws(() => ledger.reserve(-1), BudgetLedgerError);
});

test('OpenAI-compatible path (no count API) is bounded-bytes and must not claim preflight', () => {
  assert.equal(resolvePreflightTier(false), 'bounded-bytes');
  // Honest bounded-bytes use passes without claiming.
  checkTokenPreflight({ tier: 'bounded-bytes' });
  // Claiming preflight on this tier rejects.
  assert.throws(
    () => checkTokenPreflight({ tier: 'bounded-bytes', claimsPreflight: true }),
    /must not claim/,
  );
});

test('authoritative path enforces 250k/asset + 1M aggregate via measured counts', () => {
  assert.equal(resolvePreflightTier(true), 'authoritative');
  checkTokenPreflight({
    tier: 'authoritative',
    assetInputTokens: PREFLIGHT_MAX_INPUT_TOKENS_PER_ASSET,
    aggregateInputTokens: PREFLIGHT_MAX_INPUT_TOKENS_AGGREGATE,
  });
  assert.throws(
    () => checkTokenPreflight({
      tier: 'authoritative',
      assetInputTokens: PREFLIGHT_MAX_INPUT_TOKENS_PER_ASSET + 1,
      aggregateInputTokens: 10,
    }),
    /asset input tokens/,
  );
  assert.throws(
    () => checkTokenPreflight({
      tier: 'authoritative',
      assetInputTokens: 10,
      aggregateInputTokens: PREFLIGHT_MAX_INPUT_TOKENS_AGGREGATE + 1,
    }),
    /aggregate input tokens/,
  );
  // Missing measurements reject — no silent pass.
  assert.throws(() => checkTokenPreflight({ tier: 'authoritative' }), /requires measured/);
});

test('enforcePreflightTokens() spec alias is checkTokenPreflight', () => {
  assert.equal(enforcePreflightTokens, checkTokenPreflight);
  enforcePreflightTokens({ tier: 'bounded-bytes' });
  assert.throws(() => enforcePreflightTokens({ tier: 'authoritative' }), /requires measured/);
});
