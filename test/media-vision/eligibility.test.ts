import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleTiersAfterFailure,
  isGeminiConfigured,
  isGeminiWebEnabled,
  resolveVisionEligibility,
  resolveVisionEligibilityFromEnv,
  VISION_TIER_ORDER,
} from '../../src/media-vision/eligibility.js';
import { isOpenAICompatibleVisionConfigured } from '../../src/media-vision/openai-compatible.js';

describe('vision eligibility order', () => {
  it('fixed route order is native -> openai-compatible -> gemini -> gemini-web', () => {
    assert.deepEqual([...VISION_TIER_ORDER], [
      'native',
      'openai-compatible',
      'gemini',
      'gemini-web',
    ]);
  });

  it('native only when nothing configured', () => {
    assert.deepEqual(
      resolveVisionEligibility({
        openAICompatibleConfigured: false,
        geminiConfigured: false,
        geminiWebEnabled: false,
      }),
      ['native'],
    );
  });

  it('adds configured tiers in order, gemini-web last', () => {
    assert.deepEqual(
      resolveVisionEligibility({
        openAICompatibleConfigured: true,
        geminiConfigured: true,
        geminiWebEnabled: true,
      }),
      ['native', 'openai-compatible', 'gemini', 'gemini-web'],
    );
  });

  it('gemini-web stays out without explicit opt-in (disabled default)', () => {
    assert.deepEqual(
      resolveVisionEligibility({
        openAICompatibleConfigured: true,
        geminiConfigured: true,
        geminiWebEnabled: false,
      }),
      ['native', 'openai-compatible', 'gemini'],
    );
  });
});

describe('policy/auth failure never broadens eligibility', () => {
  it('failure drops the failed tier instead of unlocking anything', () => {
    const eligible = resolveVisionEligibility({
      openAICompatibleConfigured: true,
      geminiConfigured: true,
      geminiWebEnabled: false,
    });
    assert.deepEqual(eligibleTiersAfterFailure(eligible, 'openai-compatible'), [
      'native',
      'gemini',
    ]);
  });

  it('failure cannot enable gemini-web (stays a subset)', () => {
    const eligible = resolveVisionEligibility({
      openAICompatibleConfigured: true,
      geminiConfigured: false,
      geminiWebEnabled: false,
    });
    const after = eligibleTiersAfterFailure(eligible, 'openai-compatible');
    assert.deepEqual(after, ['native']);
    assert.ok(!after.includes('gemini-web'));
  });

  it('same flags recompute the same set (failure carries no config change)', () => {
    const input = {
      openAICompatibleConfigured: true,
      geminiConfigured: false,
      geminiWebEnabled: false,
    };
    assert.deepEqual(resolveVisionEligibility(input), resolveVisionEligibility(input));
  });
});

describe('env helpers', () => {
  it('gemini configured by key or vertex project only', () => {
    assert.equal(isGeminiConfigured({}), false);
    assert.equal(isGeminiConfigured({ GEMINI_API_KEY: 'x' }), true);
    assert.equal(isGeminiConfigured({ GOOGLE_GENAI_API_KEY: 'x' }), true);
    assert.equal(isGeminiConfigured({ GOOGLE_VERTEX_PROJECT: 'p' }), true);
    assert.equal(isGeminiConfigured({ GEMINI_API_KEY: '   ' }), false);
  });

  it('gemini-web requires exact "1"', () => {
    assert.equal(isGeminiWebEnabled({}), false);
    assert.equal(isGeminiWebEnabled({ PI_VISION_GEMINI_WEB_ENABLED: '1' }), true);
    assert.equal(isGeminiWebEnabled({ PI_VISION_GEMINI_WEB_ENABLED: 'true' }), false);
    assert.equal(isGeminiWebEnabled({ PI_VISION_GEMINI_WEB_ENABLED: '' }), false);
  });

  it('openai-compatible needs base URL plus exact model IDs', () => {
    assert.equal(isOpenAICompatibleVisionConfigured({}), false);
    assert.equal(
      isOpenAICompatibleVisionConfigured({
        PI_VISION_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
        PI_VISION_OPENAI_COMPAT_MODEL: 'llava',
      }),
      true,
    );
    assert.equal(
      isOpenAICompatibleVisionConfigured({
        PI_VISION_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      }),
      false,
    );
  });

  it('from-env resolves native-only when empty', () => {
    assert.deepEqual(resolveVisionEligibilityFromEnv({}), ['native']);
  });
});
