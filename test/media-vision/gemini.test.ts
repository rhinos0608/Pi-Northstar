// Plan D Task D3 tests: Gemini Developer/Vertex + Gemini Web.
// Zero-network-call gates: disabled/unconfigured states never touch transport
// (mocked counters stay 0). Sibling W-D1 seam mocked at the transport
// boundary (no static import of mid-write sibling modules).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GEMINI_DEFAULT_VISION_MODEL,
  GEMINI_MAX_INLINE_BYTES,
  createGeminiTransport,
  describeImageWithGemini,
  resolveGeminiConfig,
  type GeminiConfig,
  type GeminiTransport,
} from '../../src/media-vision/gemini.js';
import {
  GEMINI_WEB_ORIGINS,
  askGeminiWeb,
  geminiWebEnabled,
} from '../../src/media-vision/gemini-web.js';

function mockTransport(responses: { text: string; usageTokens?: number } = { text: 'seen' }): { transport: GeminiTransport; calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    transport: {
      async generateContent() {
        calls.count += 1;
        return responses.usageTokens === undefined
          ? { text: responses.text }
          : { text: responses.text, usageTokens: responses.usageTokens };
      },
      async countTokens() {
        calls.count += 1;
        return {};
      },
    },
  };
}

test('gemini disabled by default: resolve false, zero transport calls', () => {
  const result = resolveGeminiConfig({});
  assert.equal(result.ok, false);
  const { transport, calls } = mockTransport();
  assert.equal(calls.count, 0);
  assert.equal(typeof transport.generateContent, 'function');
});

test('gemini enabled without key is unconfigured (never broadens tier)', () => {
  const result = resolveGeminiConfig({ PI_VISION_GEMINI_ENABLED: '1' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unconfigured');
});

test('gemini developer config resolves with exact model id verbatim', () => {
  const result = resolveGeminiConfig({
    PI_VISION_GEMINI_ENABLED: '1',
    GEMINI_API_KEY: 'sentinel-key',
    PI_VISION_GEMINI_MODEL: 'gemini-2.0-flash-001',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.model, 'gemini-2.0-flash-001');
    assert.equal(result.config.auth.kind, 'developer');
  }
});

test('gemini default model applies when operator sets no exact model', () => {
  const result = resolveGeminiConfig({
    PI_VISION_GEMINI_ENABLED: '1',
    GEMINI_API_KEY: 'sentinel-key',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.model, GEMINI_DEFAULT_VISION_MODEL);
});

test('gemini vertex without project/location is misconfigured, not fallback', () => {
  const result = resolveGeminiConfig({
    PI_VISION_GEMINI_ENABLED: '1',
    GOOGLE_GENAI_USE_VERTEXAI: '1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'vertex-misconfigured');
});

test('gemini vertex config carries exact project/location to client factory', async () => {
  let seen: GeminiConfig | undefined;
  const factory = (config: GeminiConfig) => {
    seen = config;
    return { generate: mockTransport().transport };
  };
  const transport = createGeminiTransport(
    { model: 'gemini-2.0-flash', auth: { kind: 'vertex', project: 'proj-1', location: 'us-central1' } },
    {},
    { createClient: factory },
  );
  await transport.generateContent({ prompt: 'hi' });
  assert.equal(seen?.auth.kind, 'vertex');
  if (seen?.auth.kind === 'vertex') {
    assert.equal(seen.auth.project, 'proj-1');
    assert.equal(seen.auth.location, 'us-central1');
  }
});

test('describeImage rejects oversize payload before any transport call', async () => {
  const { transport, calls } = mockTransport();
  const config: GeminiConfig = { model: GEMINI_DEFAULT_VISION_MODEL, auth: { kind: 'developer' } };
  const big = new Uint8Array(GEMINI_MAX_INLINE_BYTES + 1);
  const result = await describeImageWithGemini(big, 'image/png', 'ocr', config, { transport });
  assert.equal(result.text, '');
  assert.ok(result.warnings.includes('image-over-byte-ceiling'));
  assert.equal(calls.count, 0);
});

test('describeImage returns text + usage verbatim through mock transport', async () => {
  const { transport, calls } = mockTransport({ text: 'a cat', usageTokens: 42 });
  const config: GeminiConfig = { model: GEMINI_DEFAULT_VISION_MODEL, auth: { kind: 'developer' } };
  const result = await describeImageWithGemini(new Uint8Array([1, 2, 3]), 'image/png', 'describe', config, { transport });
  assert.equal(result.text, 'a cat');
  assert.equal(result.usageTokens, 42);
  assert.equal(calls.count, 1);
});

test('gemini transport errors redact credential-shaped material', async () => {
  const secret = 'sk-sentinel-secret-token-abcdef123456';
  const failing: GeminiTransport = {
    async generateContent(): Promise<never> {
      throw new Error(`upstream 401 with key ${secret}`);
    },
    async countTokens() {
      return {};
    },
  };
  const config: GeminiConfig = { model: GEMINI_DEFAULT_VISION_MODEL, auth: { kind: 'developer' } };
  const transport = createGeminiTransport(config, {}, { createClient: () => ({ generate: failing }) });
  await assert.rejects(transport.generateContent({ prompt: 'x' }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return !message.includes(secret) && message.includes('[redacted]');
  });
});

test('gemini web disabled by default: zero lease calls', async () => {
  assert.equal(geminiWebEnabled({}), false);
  let leaseCalls = 0;
  const result = await askGeminiWeb('hello', {
    async acquireLease() {
      leaseCalls += 1;
      throw new Error('must not acquire while disabled');
    },
  }, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'disabled');
  assert.equal(leaseCalls, 0);
});

test('gemini web rejects non-exact lease origins before navigation', async () => {
  let navigations = 0;
  const result = await askGeminiWeb('hello', {
    async acquireLease() {
      return {
        origin: 'https://evil-gemini.example.com',
        async navigate() {
          navigations += 1;
        },
        async evaluate<T>(): Promise<T> {
          throw new Error('must not evaluate on rejected origin');
        },
      };
    },
  }, { PI_VISION_GEMINI_WEB_ENABLED: '1' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'lease-origin-rejected');
  assert.equal(navigations, 0);
  assert.ok(GEMINI_WEB_ORIGINS.includes('https://gemini.google.com'));
});

test('gemini web last-resort ask returns leased-tab text with warning', async () => {
  let evaluations = 0;
  const result = await askGeminiWeb('describe this', {
    async acquireLease() {
      return {
        origin: 'https://gemini.google.com',
        async navigate() {},
        async evaluate<T>(script: string): Promise<T> {
          evaluations += 1;
          assert.ok(script.length > 0);
          return 'leased answer' as T;
        },
      };
    },
  }, { PI_VISION_GEMINI_WEB_ENABLED: '1' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, 'leased answer');
    assert.ok(result.warnings.includes('last-resort-web-route'));
  }
  assert.equal(evaluations, 1);
});
