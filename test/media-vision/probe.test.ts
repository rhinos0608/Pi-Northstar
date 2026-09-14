import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAICompatibleVisionTransport,
  isVisionBaseUrlAllowed,
  parseVisionModelIds,
  resolveOpenAICompatibleVisionConfig,
  type OpenAICompatibleVisionConfig,
} from '../../src/media-vision/openai-compatible.js';
import {
  buildSyntheticProbeImage,
  isProbeAnswerPassing,
  isVisionRefusal,
  matchedProbeValues,
  mentionsProbeValue,
  PROBE_COLORS,
  PROBE_SHAPES,
  probeVisionModels,
  runVisionProbe,
  VISION_PROBE_PROMPT,
  type VisionProbeTransport,
} from '../../src/media-vision/probe.js';

/** Echo the randomized probe SVG back as text, like a true vision model would. */
function echoProbeImage(imageBytes: Uint8Array): string {
  const svg = new TextDecoder().decode(imageBytes);
  const shape = svg.includes('<circle') ? 'circle' : svg.includes('<polygon') ? 'triangle' : 'square';
  const fills = svg.match(/fill="(#[0-9a-f]{6})"/gi) ?? [];
  const last = (fills[1] ?? fills[0] ?? '').toLowerCase();
  const color = last.includes('e5484d') ? 'red' : last.includes('2f6feb') ? 'blue' : 'green';
  return `a ${color} ${shape} on white`;
}

const CONFIG: OpenAICompatibleVisionConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  modelIds: ['llava', 'qwen2-vl'],
};

function stubFetch(
  handler: (body: Record<string, unknown>) => { status: number; payload: unknown },
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const { status, payload } = handler(body);
    return { status, text: async () => JSON.stringify(payload) };
  };
  return { calls, fetchFn };
}

describe('openai-compatible config', () => {
  it('parses exact model IDs without normalization', () => {
    assert.deepEqual(parseVisionModelIds('llava, qwen2-vl,, '), ['llava', 'qwen2-vl']);
    assert.deepEqual(parseVisionModelIds(''), []);
    assert.deepEqual(parseVisionModelIds(undefined), []);
  });

  it('accepts any http(s) base URL including loopback', () => {
    assert.equal(isVisionBaseUrlAllowed('http://127.0.0.1:11434/v1'), true);
    assert.equal(isVisionBaseUrlAllowed('https://api.example.com/v1'), true);
    assert.equal(isVisionBaseUrlAllowed('ftp://example.com'), false);
    assert.equal(isVisionBaseUrlAllowed('not-a-url'), false);
  });

  it('resolves config with optional key, strips trailing slash', () => {
    const resolved = resolveOpenAICompatibleVisionConfig({
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1///',
      PI_VISION_OPENAI_COMPAT_MODEL: 'llava',
    });
    assert.deepEqual(resolved, {
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelIds: ['llava'],
    });
  });

  it('returns null when unconfigured or malformed (fail closed)', () => {
    assert.equal(resolveOpenAICompatibleVisionConfig({}), null);
    assert.equal(
      resolveOpenAICompatibleVisionConfig({
        PI_VISION_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434',
      }),
      null,
    );
    assert.equal(
      resolveOpenAICompatibleVisionConfig({
        PI_VISION_OPENAI_COMPAT_BASE_URL: 'ftp://x',
        PI_VISION_OPENAI_COMPAT_MODEL: 'llava',
      }),
      null,
    );
  });
});

describe('openai-compatible transport', () => {
  it('sends exact model ID to {baseUrl}/chat/completions with image part', async () => {
    const transport = createOpenAICompatibleVisionTransport(CONFIG);
    const { calls, fetchFn } = stubFetch(() => ({
      status: 200,
      payload: { choices: [{ message: { content: 'a red square' } }] },
    }));
    const result = await transport.describe(
      {
        imageBytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        prompt: 'what?',
        modelId: 'llava',
      },
      fetchFn,
    );
    assert.equal(result.ok, true);
    assert.equal(result.text, 'a red square');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${CONFIG.baseUrl}/chat/completions`);
    assert.equal((calls[0]!.body as { model: string }).model, 'llava');
    const content = (calls[0]!.body as { messages: Array<{ content: unknown[] }> })
      .messages[0]!.content;
    assert.ok(
      content.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type: string }).type === 'image_url',
      ),
    );
  });

  it('rejects unknown model IDs before any network call', async () => {
    const transport = createOpenAICompatibleVisionTransport(CONFIG);
    let calls = 0;
    const result = await transport.describe(
      {
        imageBytes: new Uint8Array([1]),
        mimeType: 'image/png',
        prompt: 'what?',
        modelId: 'gpt-xyz',
      },
      (async () => {
        calls += 1;
        return { status: 200, text: async () => '{}' };
      }) as never,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unsupported_model');
    assert.equal(calls, 0);
  });

  it('rejects oversize payloads and maps upstream failures', async () => {
    const transport = createOpenAICompatibleVisionTransport(CONFIG);
    const big = await transport.describe(
      {
        imageBytes: new Uint8Array(20 * 1024 * 1024 + 1),
        mimeType: 'image/png',
        prompt: 'what?',
        modelId: 'llava',
      },
      (async () => {
        throw new Error('must not be called');
      }) as never,
    );
    assert.equal(big.ok, false);
    assert.equal(big.error, 'response_too_large');

    const { fetchFn } = stubFetch(() => ({ status: 500, payload: {} }));
    const failed = await transport.describe(
      {
        imageBytes: new Uint8Array([1]),
        mimeType: 'image/png',
        prompt: 'what?',
        modelId: 'llava',
      },
      fetchFn,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'upstream_error:500');
  });

  it('reports post-response usage when present, omits when absent', async () => {
    const transport = createOpenAICompatibleVisionTransport(CONFIG);
    const withUsage = stubFetch(() => ({
      status: 200,
      payload: {
        choices: [{ message: { content: 'seen' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      },
    }));
    const ok = await transport.describe(
      {
        imageBytes: new Uint8Array([1]),
        mimeType: 'image/png',
        prompt: 'what?',
        modelId: 'llava',
      },
      withUsage.fetchFn,
    );
    assert.deepEqual(ok.usage, {
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
    });
    const withoutUsage = stubFetch(() => ({
      status: 200,
      payload: { choices: [{ message: { content: 'seen' } }] },
    }));
    const plain = await transport.describe(
      {
        imageBytes: new Uint8Array([1]),
        mimeType: 'image/png',
        prompt: 'what?',
        modelId: 'llava',
      },
      withoutUsage.fetchFn,
    );
    assert.equal(plain.usage, undefined);
  });
});

describe('synthetic vision probe', () => {
  it('probe image is tiny synthetic bytes, prompt is closed-vocabulary', () => {
    const { bytes, mimeType, shape, color } = buildSyntheticProbeImage();
    assert.equal(mimeType, 'image/svg+xml');
    assert.ok(bytes.byteLength > 0 && bytes.byteLength < 1024);
    assert.ok(['circle', 'square', 'triangle'].includes(shape));
    assert.ok(['red', 'blue', 'green'].includes(color));
    assert.ok(VISION_PROBE_PROMPT.length > 0);
    assert.ok(!VISION_PROBE_PROMPT.includes(shape));
    assert.ok(!VISION_PROBE_PROMPT.includes(color));
  });

  it('probe challenge varies across draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      const { shape, color } = buildSyntheticProbeImage();
      seen.add(`${shape}:${color}`);
    }
    assert.ok(seen.size > 1);
  });

  it('mentionsProbeValue uses word matches, not substrings', () => {
    assert.equal(mentionsProbeValue('a colored square', 'square'), true);
    assert.equal(mentionsProbeValue('a colored square', 'red'), false);
    assert.equal(mentionsProbeValue('a red square', 'red'), true);
  });

  it('mentionsProbeValue escapes RegExp metacharacters (literal match)', () => {
    assert.equal(mentionsProbeValue('a red square', 'red'), true);
    // '.' must not act as a wildcard: 'red' does not contain 'r.d' literally.
    assert.equal(mentionsProbeValue('a red square', 'r.d'), false);
    assert.equal(mentionsProbeValue('price (red) here', 'red'), true);
    assert.equal(mentionsProbeValue('a red square', '(red)'), false);
    assert.equal(mentionsProbeValue('a red+blue square', 'red+blue'), true);
  });

  it('exclusivity: full-vocabulary enumeration fails even naming expected pair', () => {
    const enumeration = [...PROBE_SHAPES, ...PROBE_COLORS.map((c) => c.name)].join(' ');
    assert.ok(matchedProbeValues(enumeration, PROBE_SHAPES).length > 1);
    assert.ok(matchedProbeValues(enumeration, PROBE_COLORS.map((c) => c.name)).length > 1);
    assert.equal(isProbeAnswerPassing(enumeration, 'circle', 'red'), false);
    assert.equal(isProbeAnswerPassing(enumeration, 'square', 'blue'), false);
  });

  it('exclusivity: single wrong pair fails, exact single pair passes', () => {
    assert.equal(isProbeAnswerPassing('a red circle on white', 'square', 'blue'), false);
    assert.equal(isProbeAnswerPassing('a blue square on white', 'square', 'blue'), true);
    // Extra vocab hit on either axis fails: two shapes or two colors.
    assert.equal(isProbeAnswerPassing('a blue square and a red circle', 'square', 'blue'), false);
    assert.equal(isProbeAnswerPassing('a blue and red square', 'square', 'blue'), false);
  });

  it('exclusivity: plural forms of the single pair still pass', () => {
    assert.equal(isProbeAnswerPassing('two blue squares on white', 'square', 'blue'), true);
    assert.equal(isProbeAnswerPassing('red circles everywhere', 'circle', 'red'), true);
  });

  it('rejects a full-vocabulary enumeration answer without vision', async () => {
    const enumeration = [...PROBE_SHAPES, ...PROBE_COLORS.map((c) => c.name)].join(' ');
    const transport: VisionProbeTransport = {
      describe: async () => ({ ok: true, text: enumeration }),
    };
    const result = await runVisionProbe(transport, { modelId: 'vocab-lister' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'probe_mismatch');
  });

  it('accepts a model that describes the probe image', async () => {
    const transport: VisionProbeTransport = {
      describe: async (request) => {
        assert.ok(request.imageBytes.byteLength > 0);
        assert.equal(request.prompt, VISION_PROBE_PROMPT);
        return { ok: true, text: echoProbeImage(request.imageBytes) };
      },
    };
    const result = await runVisionProbe(transport, { modelId: 'llava' });
    assert.equal(result.ok, true);
    assert.equal(result.modelId, 'llava');
  });

  it('rejects ungrounded descriptions missing shape or color', async () => {
    for (const text of ['a nice picture', 'a red thing', 'a square']) {
      const transport: VisionProbeTransport = {
        describe: async () => ({ ok: true, text }),
      };
      const result = await runVisionProbe(transport, { modelId: 'text-model' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'probe_mismatch');
    }
  });

  it('rejects non-vision models (refusal text)', async () => {
    for (const text of [
      'I cannot see images, I am a text-only model.',
      "I don't have vision capabilities.",
    ]) {
      assert.equal(isVisionRefusal(text), true);
      const transport: VisionProbeTransport = {
        describe: async () => ({ ok: true, text }),
      };
      const result = await runVisionProbe(transport, { modelId: 'text-model' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'non_vision_model');
    }
  });

  it('rejects empty responses and transport failures fail-closed', async () => {
    const empty: VisionProbeTransport = { describe: async () => ({ ok: true, text: '  ' }) };
    assert.equal((await runVisionProbe(empty, { modelId: 'm' })).reason, 'empty_vision_response');
    const failing: VisionProbeTransport = {
      describe: async () => ({ ok: false, error: 'upstream_error:500' }),
    };
    const failed = await runVisionProbe(failing, { modelId: 'm' });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'upstream_error:500');
    const throwing: VisionProbeTransport = {
      describe: async () => {
        throw new Error('boom');
      },
    };
    assert.equal((await runVisionProbe(throwing, { modelId: 'm' })).reason, 'transport_error');
  });

  it('probes exact model IDs in order with stop-at-first-pass', async () => {
    const transport: VisionProbeTransport = {
      describe: async (request) =>
        request.modelId === 'good'
          ? { ok: true, text: echoProbeImage(request.imageBytes) }
          : { ok: true, text: 'I cannot view images.' },
    };
    const results = await probeVisionModels(transport, ['bad', 'good', 'later'], {
      stopAtFirstPass: true,
    });
    assert.deepEqual(
      results.map((r) => r.modelId),
      ['bad', 'good'],
    );
    assert.equal(results[1]!.ok, true);
  });
});
