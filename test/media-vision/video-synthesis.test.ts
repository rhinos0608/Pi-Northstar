import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOpenAICompatibleVisionTransport,
  resolveOpenAICompatibleVisionConfig,
  VISION_TEXT_MAX_PROMPT_CHARS,
} from '../../src/media-vision/openai-compatible.js';
import {
  isVideoSynthesisConfigured,
  synthesizeVideoEvidence,
  VIDEO_SYNTHESIS_MAX_CHARS,
} from '../../src/media-vision/video-synthesis.js';

const OPENAI_ENV = {
  PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
  PI_VISION_OPENAI_COMPAT_MODEL: 'test-model',
};

function chatOk(text: string) {
  return async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content: text } }], usage: { total_tokens: 3 } }),
  });
}

test('video-synthesis: unconfigured env returns undefined and reports false', async () => {
  assert.equal(await synthesizeVideoEvidence('some evidence', { env: {} }), undefined);
  assert.equal(isVideoSynthesisConfigured({}), false);
  assert.equal(isVideoSynthesisConfigured(OPENAI_ENV), true);
});

test('video-synthesis: empty evidence returns undefined without transport', async () => {
  let calls = 0;
  const out = await synthesizeVideoEvidence('   ', {
    env: OPENAI_ENV,
    openaiFetch: (async () => {
      calls += 1;
      return chatOk('x')();
    }) as never,
  });
  assert.equal(out, undefined);
  assert.equal(calls, 0);
});

test('video-synthesis: explicit model outside the allowlist returns undefined', async () => {
  const out = await synthesizeVideoEvidence('evidence words', {
    env: OPENAI_ENV,
    modelId: 'not-allowlisted',
    openaiFetch: chatOk('SHOULD NOT APPEAR') as never,
  });
  assert.equal(out, undefined);
});

test('video-synthesis: openai-compatible tier synthesizes with injected fetch', async () => {
  const seen: string[] = [];
  const out = await synthesizeVideoEvidence('cats playing piano at 0:42', {
    env: OPENAI_ENV,
    openaiFetch: (async (_url: string, init: { body?: string }) => {
      seen.push(String(init.body ?? ''));
      return chatOk('piano cats digest')();
    }) as never,
  });
  assert.deepEqual(out, { text: 'piano cats digest', model: 'test-model' });
  assert.ok(seen[0]?.includes('cats playing piano'), 'evidence must reach the prompt');
  assert.ok(seen[0]?.includes('untrusted'), 'prompt must frame evidence as untrusted');
});

test('video-synthesis: gemini tier synthesizes with injected transport', async () => {
  const out = await synthesizeVideoEvidence('dogs surfing', {
    env: { PI_VISION_GEMINI_ENABLED: '1', GEMINI_API_KEY: 'k', PI_VISION_GEMINI_MODEL: 'gem' },
    geminiTransport: {
      generateContent: async () => ({ text: 'surfing dogs digest' }),
      countTokens: async () => ({}),
    },
  });
  assert.deepEqual(out, { text: 'surfing dogs digest', model: 'gem' });
});

test('video-synthesis: tier failure falls back to evidence-only (undefined)', async () => {
  const out = await synthesizeVideoEvidence('evidence words', {
    env: OPENAI_ENV,
    openaiFetch: (async () => ({ status: 500, text: async () => 'boom' })) as never,
  });
  assert.equal(out, undefined);
});

test('video-synthesis: describeText rejects out-of-allowlist model', async () => {
  const config = resolveOpenAICompatibleVisionConfig(OPENAI_ENV);
  assert.ok(config);
  const transport = createOpenAICompatibleVisionTransport(config);
  const out = await transport.describeText({ prompt: 'hi', modelId: 'nope' }, chatOk('x') as never);
  assert.deepEqual(out, { ok: false, error: 'unsupported_model' });
});

test('video-synthesis: describeText reject-not-clamp bounds', async () => {
  const config = resolveOpenAICompatibleVisionConfig(OPENAI_ENV);
  assert.ok(config);
  const transport = createOpenAICompatibleVisionTransport(config);
  const fetch = chatOk('x') as never;
  assert.deepEqual(await transport.describeText({ prompt: '', modelId: 'test-model' }, fetch), {
    ok: false, error: 'invalid_input',
  });
  assert.deepEqual(
    await transport.describeText({ prompt: 'x'.repeat(VISION_TEXT_MAX_PROMPT_CHARS + 1), modelId: 'test-model' }, fetch),
    { ok: false, error: 'prompt_too_large' },
  );
  for (const maxOutputTokens of [0, -1, 1.5, Number.NaN]) {
    const out = await transport.describeText({ prompt: 'hi', modelId: 'test-model', maxOutputTokens }, fetch);
    assert.deepEqual(out, { ok: false, error: 'invalid_input' });
  }
  for (const timeoutMs of [0, -5, 2.5]) {
    const out = await transport.describeText({ prompt: 'hi', modelId: 'test-model', timeoutMs }, fetch);
    assert.deepEqual(out, { ok: false, error: 'invalid_input' });
  }
  const ok = await transport.describeText({ prompt: 'hi', modelId: 'test-model', maxOutputTokens: 64 }, fetch);
  assert.equal(ok.ok, true);
});

test('video-synthesis: evidence at VIDEO_SYNTHESIS_MAX_CHARS synthesizes within prompt bound', async () => {
  const seen: string[] = [];
  const out = await synthesizeVideoEvidence('x'.repeat(VIDEO_SYNTHESIS_MAX_CHARS), {
    env: OPENAI_ENV,
    openaiFetch: (async (_url: string, init: { body?: string }) => {
      seen.push(String(init.body ?? ''));
      return chatOk('boundary digest')();
    }) as never,
  });
  assert.deepEqual(out, { text: 'boundary digest', model: 'test-model' });
  const prompt = JSON.parse(seen[0] ?? '{}').messages?.[0]?.content?.[0]?.text ?? '';
  assert.ok(prompt.length > 0, 'composed prompt must be present in the transport body');
  assert.ok(prompt.length <= VISION_TEXT_MAX_PROMPT_CHARS, 'composed prompt must stay within the transport bound');
});

test('video-synthesis: describeText sends text-only parts (no image_url)', async () => {
  const config = resolveOpenAICompatibleVisionConfig(OPENAI_ENV);
  assert.ok(config);
  const transport = createOpenAICompatibleVisionTransport(config);
  let body = '';
  await transport.describeText(
    { prompt: 'summarize', modelId: 'test-model' },
    (async (_url: string, init: { body?: string }) => {
      body = String(init.body ?? '');
      return chatOk('done')();
    }) as never,
  );
  assert.ok(body.includes('summarize'));
  assert.ok(!body.includes('image_url'), 'describeText must never carry image parts');
});
