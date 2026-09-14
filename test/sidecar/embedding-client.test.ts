import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import * as http from 'node:http';
import * as net from 'node:net';
import { EmbeddingClient, EmbeddingUnavailableError } from '../../src/sidecar/embedding-client.js';

/**
 * Integration-style tests using a real node:http mock server.
 * Each test sets up the server's request handler before calling the client.
 */

let server: http.Server;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let baseUrl: string;

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
});

// ---------------------------------------------------------------------------
// embed()
// ---------------------------------------------------------------------------

test('embed sends correct body and parses embedding response', async () => {
  handler = (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.input, 'hello world');
      jsonResponse(res, {
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: 'embedding' }],
        model: 'test-model',
        object: 'list',
      });
    });
  };

  const client = new EmbeddingClient({ baseUrl });
  const result = await client.embed('hello world');

  assert(result instanceof Float32Array);
  assert.equal(result.length, 3);
  const f32 = (v: number) => new Float32Array([v])[0];
  assert.equal(result[0], f32(0.1));
  assert.equal(result[1], f32(0.2));
  assert.equal(result[2], f32(0.3));
});

// ---------------------------------------------------------------------------
// embedBatch()
// ---------------------------------------------------------------------------

test('embedBatch sends array input and returns embeddings in order', async () => {
  handler = (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.deepEqual(parsed.input, ['a', 'b']);
      jsonResponse(res, {
        data: [
          { embedding: [0.1, 0.2], index: 0, object: 'embedding' },
          { embedding: [0.3, 0.4], index: 1, object: 'embedding' },
        ],
        model: 'test-model',
        object: 'list',
      });
    });
  };

  const client = new EmbeddingClient({ baseUrl });
  const results = await client.embedBatch(['a', 'b']);

  assert.equal(results.length, 2);
  assert(results[0] instanceof Float32Array);
  assert(results[1] instanceof Float32Array);
  const f32 = (v: number) => new Float32Array([v])[0];
  assert.equal(results[0][0], f32(0.1));
  assert.equal(results[0][1], f32(0.2));
  assert.equal(results[1][0], f32(0.3));
  assert.equal(results[1][1], f32(0.4));
});

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

test('health parses health response', async () => {
  handler = (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/health');
    jsonResponse(res, { status: 'ok', model: 'test-model', dimensions: 768, device: 'cpu' });
  };

  const client = new EmbeddingClient({ baseUrl });
  const result = await client.health();

  assert.equal(result.status, 'ok');
  assert.equal(result.model, 'test-model');
  assert.equal(result.dimensions, 768);
  assert.equal(result.device, 'cpu');
});

// ---------------------------------------------------------------------------
// apiToken (local sidecar handshake)
// ---------------------------------------------------------------------------

test('explicit apiToken sends Authorization header', async () => {
  let auth: string | undefined;
  handler = (req, res) => {
    auth = req.headers.authorization as string | undefined;
    jsonResponse(res, { status: 'ok', model: 'm', dimensions: 1, device: 'cpu' });
  };

  const client = new EmbeddingClient({ baseUrl, apiToken: 'local-token-abc' });
  await client.health();

  assert.equal(auth, 'Bearer local-token-abc');
});

test('explicit apiToken wins over EMBEDDING_SIDECAR_API_TOKEN env', async () => {
  const prev = process.env.EMBEDDING_SIDECAR_API_TOKEN;
  process.env.EMBEDDING_SIDECAR_API_TOKEN = 'env-token';
  try {
    let auth: string | undefined;
    handler = (req, res) => {
      auth = req.headers.authorization as string | undefined;
      jsonResponse(res, { status: 'ok' });
    };
    const client = new EmbeddingClient({ baseUrl, apiToken: 'explicit-token' });
    await client.health();
    assert.equal(auth, 'Bearer explicit-token');
  } finally {
    if (prev === undefined) delete process.env.EMBEDDING_SIDECAR_API_TOKEN;
    else process.env.EMBEDDING_SIDECAR_API_TOKEN = prev;
  }
});

test('no token sends no Authorization header', async () => {
  const prev = process.env.EMBEDDING_SIDECAR_API_TOKEN;
  delete process.env.EMBEDDING_SIDECAR_API_TOKEN;
  try {
    let auth: string | undefined | string[];
    handler = (req, res) => {
      auth = req.headers.authorization;
      jsonResponse(res, { status: 'ok' });
    };
    const client = new EmbeddingClient({ baseUrl });
    await client.health();
    assert.equal(auth, undefined);
  } finally {
    if (prev !== undefined) process.env.EMBEDDING_SIDECAR_API_TOKEN = prev;
  }
});

test('apiTokenProvider wins over apiToken snapshot per request', async () => {
  const seen: Array<string | undefined> = [];
  handler = (req, res) => {
    seen.push(req.headers.authorization as string | undefined);
    jsonResponse(res, { status: 'ok' });
  };
  let current = 'token-v1';
  const client = new EmbeddingClient({
    baseUrl,
    apiToken: 'stale-snapshot',
    apiTokenProvider: () => current,
  });
  await client.health();
  // Simulate a sidecar restart minting a fresh token: the same long-lived
  // client must send the new token without reconstruction.
  current = 'token-v2';
  await client.health();
  assert.deepEqual(seen, ['Bearer token-v1', 'Bearer token-v2']);
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

test('timeout: server does not respond, client throws after timeout', async () => {
  handler = (_req, _res) => {
    // Never respond
  };

  const client = new EmbeddingClient({ baseUrl, timeout: 200, maxRetries: 1 });
  await assert.rejects(
    () => client.embed('test'),
    (err: unknown) => err instanceof EmbeddingUnavailableError,
  );
});

// ---------------------------------------------------------------------------
// Retry on transient failure
// ---------------------------------------------------------------------------

test('retry: server fails with 503 once then succeeds', async () => {
  let callCount = 0;

  handler = (_req, res) => {
    callCount++;
    if (callCount === 1) {
      jsonResponse(res, { error: 'overloaded' }, 503);
      return;
    }
    jsonResponse(res, {
      data: [{ embedding: [0.5], index: 0, object: 'embedding' }],
      model: 'test-model',
      object: 'list',
    });
  };

  const client = new EmbeddingClient({ baseUrl, maxRetries: 2 });
  const result = await client.embed('retry me');

  assert.equal(callCount, 2);
  assert(result instanceof Float32Array);
  assert.equal(result[0], 0.5);
});

// ---------------------------------------------------------------------------
// Server returns error (5xx all attempts) -> throws after retries
// ---------------------------------------------------------------------------

test('Server returns 5xx error: client retries then throws EmbeddingUnavailableError', async () => {
  let callCount = 0;

  handler = (_req, res) => {
    callCount++;
    jsonResponse(res, { error: 'server error' }, 500);
  };

  const client = new EmbeddingClient({ baseUrl, maxRetries: 3 });
  await assert.rejects(
    () => client.embed('fail'),
    (err: unknown) => err instanceof EmbeddingUnavailableError && (err as EmbeddingUnavailableError).status === 500,
  );
  assert.equal(callCount, 3);
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

test('truncation: text over 8192 chars is truncated before sending', async () => {
  const longText = 'x'.repeat(10000);
  let receivedInput: unknown = null;

  handler = (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      receivedInput = JSON.parse(body).input;
      jsonResponse(res, {
        data: [{ embedding: [1.0], index: 0, object: 'embedding' }],
        model: 'test-model',
        object: 'list',
      });
    });
  };

  const client = new EmbeddingClient({ baseUrl });
  await client.embed(longText);

  assert.equal(typeof receivedInput, 'string');
  assert.equal((receivedInput as string).length, 8192);
});

// ---------------------------------------------------------------------------
// Empty text
// ---------------------------------------------------------------------------

test('empty text is handled gracefully', async () => {
  handler = (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      assert.equal(JSON.parse(body).input, '');
      jsonResponse(res, {
        data: [{ embedding: [], index: 0, object: 'embedding' }],
        model: 'test-model',
        object: 'list',
      });
    });
  };

  const client = new EmbeddingClient({ baseUrl });
  const result = await client.embed('');

  assert(result instanceof Float32Array);
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// Non-retryable error (4xx) -> throws immediately
// ---------------------------------------------------------------------------

test('retry rebuilds the Authorization header per attempt (restart during backoff)', async () => {
  const seen: Array<string | undefined> = [];
  let current = 'token-v1';
  let callCount = 0;

  handler = (req, res) => {
    seen.push(req.headers.authorization as string | undefined);
    callCount++;
    if (callCount === 1) {
      // Simulate a sidecar restart minting a fresh token during backoff.
      current = 'token-v2';
      jsonResponse(res, { error: 'overloaded' }, 503);
      return;
    }
    jsonResponse(res, {
      data: [{ embedding: [0.5], index: 0, object: 'embedding' }],
      model: 'test-model',
      object: 'list',
    });
  };

  const client = new EmbeddingClient({ baseUrl, apiToken: 'stale-snapshot', apiTokenProvider: () => current, maxRetries: 2 });
  const result = await client.embed('retry me');

  assert.equal(callCount, 2);
  assert.deepEqual(seen, ['Bearer token-v1', 'Bearer token-v2']);
  assert(result instanceof Float32Array);
});

test('4xx error throws EmbeddingUnavailableError without retry', async () => {
  let callCount = 0;

  handler = (_req, res) => {
    callCount++;
    jsonResponse(res, { error: 'bad request' }, 400);
  };

  const client = new EmbeddingClient({ baseUrl, maxRetries: 3 });
  await assert.rejects(
    () => client.embed('bad'),
    (err: unknown) => err instanceof EmbeddingUnavailableError && (err as EmbeddingUnavailableError).status === 400,
  );
  assert.equal(callCount, 1);
});
