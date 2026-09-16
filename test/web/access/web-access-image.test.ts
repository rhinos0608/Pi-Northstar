import assert from 'node:assert/strict';
import { test } from 'node:test';

// M4 remote-image specialist: extension gate, sniff-first metadata, ceilings,
// double-gated description. acquireAsset deps inject fetch, so no global
// stubbing is needed here.

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imageFetchStub(bytes: Uint8Array, contentType: string) {
  return async () =>
    new Response(bodyOf(bytes), { status: 200, headers: { 'content-type': contentType } });
}

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 as const }];

test('web-access-image: isImageUrl gates on sniff-supported extensions only', async () => {
  const { isImageUrl } = await import('../../../src/web/access/web-access-image.js');
  assert.equal(isImageUrl('https://example.com/a.png'), true);
  assert.equal(isImageUrl('https://example.com/a.JPG?w=2'), true);
  assert.equal(isImageUrl('https://example.com/a.webp'), true);
  assert.equal(isImageUrl('https://example.com/a.gif'), true);
  assert.equal(isImageUrl('https://example.com/a.jpeg'), true);
  assert.equal(isImageUrl('https://example.com/a.pdf'), false);
  assert.equal(isImageUrl('https://example.com/a.svg'), false);
  assert.equal(isImageUrl('https://example.com/no-ext'), false);
  assert.equal(isImageUrl('not a url'), false);
});

test('web-access-image: fetchRemoteImage returns sniff-verified metadata', async () => {
  const { fetchRemoteImage } = await import('../../../src/web/access/web-access-image.js');
  const bytes = pngBytes(800, 600);
  const image = await fetchRemoteImage('https://example.com/pic.png', {
    fetchFn: imageFetchStub(bytes, 'image/png'),
    lookup: PUBLIC_LOOKUP,
  });
  assert.equal(image.mime, 'image/png');
  assert.equal(image.bytes.byteLength, bytes.byteLength);
  assert.equal(image.width, 800);
  assert.equal(image.height, 600);
  assert.equal(image.pixels, 480000);
});

test('web-access-image: sniff-first rejects magic/announced disagreement', async () => {
  const { fetchRemoteImage } = await import('../../../src/web/access/web-access-image.js');
  // Unknown magic with a non-image announcement: not an image.
  await assert.rejects(
    fetchRemoteImage('https://example.com/pic.png', {
      fetchFn: imageFetchStub(new TextEncoder().encode('just text, no magic'), 'text/plain'),
      lookup: PUBLIC_LOOKUP,
    }),
    /magic bytes|not image/i,
  );
  // PDF magic requested as an image: sniff says pdf, expected image.
  await assert.rejects(
    fetchRemoteImage('https://example.com/pic.png', {
      fetchFn: imageFetchStub(new TextEncoder().encode('%PDF-1.4 fake'), 'application/pdf'),
      lookup: PUBLIC_LOOKUP,
    }),
    /say pdf, expected image/,
  );
});

test('web-access-image: pixel ceiling rejects, never truncates', async () => {
  const { fetchRemoteImage } = await import('../../../src/web/access/web-access-image.js');
  await assert.rejects(
    fetchRemoteImage('https://example.com/huge.png', {
      fetchFn: imageFetchStub(pngBytes(100000, 100000), 'image/png'),
      lookup: PUBLIC_LOOKUP,
    }),
    /exceeds .* pixels/,
  );
});

test('web-access-image: redirect ceiling and https downgrade reject', async () => {
  const { fetchRemoteImage } = await import('../../../src/web/access/web-access-image.js');
  const loop = async () => new Response('', { status: 302, headers: { location: 'https://example.com/loop.png' } });
  await assert.rejects(
    fetchRemoteImage('https://example.com/loop.png', { fetchFn: loop, lookup: PUBLIC_LOOKUP }),
    /redirect limit exceeded/,
  );
  const downgrade = async () => new Response('', { status: 302, headers: { location: 'http://example.com/pic.png' } });
  await assert.rejects(
    fetchRemoteImage('https://example.com/pic.png', { fetchFn: downgrade, lookup: PUBLIC_LOOKUP }),
    /downgrades https to http/,
  );
});

test('web-access-image: abort rejects instead of returning partial metadata', async () => {
  const { fetchRemoteImage } = await import('../../../src/web/access/web-access-image.js');
  const controller = new AbortController();
  controller.abort();
  const aborting = async (_url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return new Response(bodyOf(pngBytes(10, 10)), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  await assert.rejects(
    fetchRemoteImage('https://example.com/pic.png', {
      fetchFn: aborting as typeof fetch,
      lookup: PUBLIC_LOOKUP,
      signal: controller.signal,
    }),
  );
});

test('web-access-image: no vision tier means metadata only, even with opt-in', async () => {
  const { describeFetchedImage } = await import('../../../src/web/access/web-access-image.js');
  const bytes = pngBytes(100, 80);
  assert.equal(await describeFetchedImage(bytes, 'image/png', { PI_VISION_FETCH_DESCRIBE: '1' }), undefined);
  // Opt-in absent with a configured tier: still metadata only.
  assert.equal(
    await describeFetchedImage(bytes, 'image/png', {
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:9',
      PI_VISION_OPENAI_COMPAT_MODEL: 'm',
    }),
    undefined,
  );
});

test('web-access-image: configured tier with injected transport describes, labeled', async () => {
  const { describeFetchedImage } = await import('../../../src/web/access/web-access-image.js');
  const bytes = pngBytes(100, 80);
  const openai = await describeFetchedImage(
    bytes,
    'image/png',
    {
      PI_VISION_FETCH_DESCRIBE: '1',
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:9',
      PI_VISION_OPENAI_COMPAT_MODEL: 'test-model',
    },
    { describeWithOpenAI: async () => 'A red square on white.' },
  );
  assert.deepEqual(openai, { tier: 'openai-compatible', text: 'A red square on white.' });

  const gemini = await describeFetchedImage(
    bytes,
    'image/png',
    { PI_VISION_FETCH_DESCRIBE: '1', PI_VISION_GEMINI_ENABLED: '1', GEMINI_API_KEY: 'k' },
    { describeWithGemini: async () => 'A blue circle.' },
  );
  assert.deepEqual(gemini, { tier: 'gemini', text: 'A blue circle.' });
});

test('web-access-image: sniff mismatch and empty bytes never describe', async () => {
  const { describeFetchedImage } = await import('../../../src/web/access/web-access-image.js');
  const bytes = pngBytes(100, 80);
  const env = {
    PI_VISION_FETCH_DESCRIBE: '1',
    PI_VISION_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:9',
    PI_VISION_OPENAI_COMPAT_MODEL: 'm',
  };
  let calls = 0;
  const seams = {
    describeWithOpenAI: async () => {
      calls += 1;
      return 'must not run';
    },
  };
  assert.equal(await describeFetchedImage(bytes, 'image/jpeg', env, seams), undefined);
  assert.equal(await describeFetchedImage(new Uint8Array(0), 'image/png', env, seams), undefined);
  assert.equal(calls, 0);
});
