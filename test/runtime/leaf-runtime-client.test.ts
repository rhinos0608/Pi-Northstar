// Fake EventBus + v1-conformant stub server driving LeafRuntimeClient tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUNTIME_RPC_BOUNDS,
  RUNTIME_RPC_READY_EVENT,
  RUNTIME_RPC_REQUEST_EVENT,
  RUNTIME_RPC_PROTOCOL,
  RUNTIME_RPC_VERSION,
  runtimeRpcReplyEvent,
} from '../../src/runtime/runtime-rpc-protocol.js';
import { LeafRuntimeClient } from '../../src/runtime/leaf-runtime-client.js';

type Handler = (data: unknown) => void;

class FakeBus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Set<Handler>>();

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }

  on(channel: string, handler: Handler): () => void {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      this.handlers.get(channel)?.delete(handler);
    };
  }

  subscriptionCount(channel?: string): number {
    if (channel !== undefined) return this.handlers.get(channel)?.size ?? 0;
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }

  requests(): unknown[] {
    return this.emitted.filter((entry) => entry.channel === RUNTIME_RPC_REQUEST_EVENT).map((entry) => entry.data);
  }
}

const MODEL = 'testprov/test-model-xyz';

/** v1-conformant stub server: replies on exact reply channels, emits ready. */
function stubServer(bus: FakeBus, opts?: { runs?: Map<string, string>; negotiateCode?: string }): void {
  const runs = opts?.runs ?? new Map<string, string>();
  let n = 0;
  bus.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
    const request = raw as { requestId: string; method: string; params: Record<string, unknown> };
    const replyTo = runtimeRpcReplyEvent(request.requestId);
    const ok = (data: unknown): void => {
      bus.emit(replyTo, { version: 1, requestId: request.requestId, method: request.method, success: true, data });
    };
    const fail = (code: string): void => {
      bus.emit(replyTo, { version: 1, requestId: request.requestId, method: request.method, success: false, error: { code, message: 'stub' } });
    };
    switch (request.method) {
      case 'negotiate':
        if (opts?.negotiateCode !== undefined) fail(opts.negotiateCode);
        else ok({ compatible: true, modelId: (request.params as { modelId: string }).modelId, capabilities: {} });
        break;
      case 'start': {
        n += 1;
        const runId = `runtime_stub${n}`;
        runs.set(runId, 'running');
        ok({ runId, state: 'running' });
        break;
      }
      case 'status': {
        const runId = (request.params as { runId: string }).runId;
        const state = runs.get(runId) ?? 'failed';
        const settled = state === 'running' ? 'completed' : state;
        runs.set(runId, settled);
        ok({ runId, state: settled, startedAt: 1, updatedAt: 2 });
        break;
      }
      case 'result': {
        const runId = (request.params as { runId: string }).runId;
        ok({ runId, state: 'completed', output: 'leaf report text', outputTokens: 4, truncated: false });
        break;
      }
      case 'cancelAndSettle': {
        const runIds = (request.params as { runIds: string[] }).runIds;
        ok({ settlements: runIds.map((runId) => ({ runId, state: 'cancelled' })) });
        break;
      }
      default:
        fail('unsupported_method');
    }
  });
}

function emitReady(bus: FakeBus): void {
  bus.emit(RUNTIME_RPC_READY_EVENT, {
    version: RUNTIME_RPC_VERSION,
    protocol: RUNTIME_RPC_PROTOCOL,
    methods: ['negotiate', 'start', 'status', 'result', 'cancelAndSettle'],
  });
}

test('happy runLeaf returns text-only DTO', async () => {
  const bus = new FakeBus();
  stubServer(bus);
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL, pollIntervalMs: 5 });
  try {
    const out = await client.runLeaf('summarize alpha', { timeoutMs: 10_000 });
    assert.deepEqual(out, { text: 'leaf report text' });
    assert.deepEqual(Object.keys(out), ['text']);
    const methods = bus.requests().map((entry) => (entry as { method: string }).method);
    assert.ok(methods.includes('negotiate'));
    assert.ok(methods.includes('start'));
    // Start params carry the exact model id and a valid correlation block.
    const start = bus.requests().find((entry) => (entry as { method: string }).method === 'start') as {
      params: { modelId: string; correlation: { owner: string } };
    };
    assert.equal(start.params.modelId, MODEL);
    assert.equal(start.params.correlation.owner, 'northstar');
  } finally {
    client.dispose();
  }
});

test('ready tracking + refreshReady success', async () => {
  const bus = new FakeBus();
  stubServer(bus);
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL });
  try {
    assert.equal(client.isReady(), false);
    emitReady(bus);
    assert.equal(client.isReady(), true);
    assert.equal(await client.refreshReady(), true);
  } finally {
    client.dispose();
  }
});

test('refreshReady false on runtime_unavailable; stale ready never trusted alone', async () => {
  const bus = new FakeBus();
  stubServer(bus, { negotiateCode: 'runtime_unavailable' });
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL });
  try {
    emitReady(bus);
    assert.equal(client.isReady(), true);
    assert.equal(await client.refreshReady(), false);
  } finally {
    client.dispose();
  }
});

test('refreshReady works when ready event fired before client subscribed', async () => {
  const bus = new FakeBus();
  stubServer(bus);
  emitReady(bus); // Before any client subscription exists.
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL, pollIntervalMs: 5 });
  try {
    assert.equal(client.isReady(), false);
    assert.equal(await client.refreshReady(), true);
    assert.equal(client.isReady(), true);
  } finally {
    client.dispose();
  }
});

test('timeout fails closed and attempts cancelAndSettle', async () => {
  const bus = new FakeBus();
  // No server: never replies. Seed a known run via a first client? Instead
  // drive timeout on negotiate (no known runs) and separately verify the
  // cancel envelope shape with a server that stalls after start.
  const stalled = new FakeBus();
  let started = '';
  stalled.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
    const request = raw as { requestId: string; method: string; params: Record<string, unknown> };
    const replyTo = runtimeRpcReplyEvent(request.requestId);
    if (request.method === 'negotiate') {
      stalled.emit(replyTo, { version: 1, requestId: request.requestId, method: 'negotiate', success: true, data: { compatible: true, modelId: MODEL } });
    } else if (request.method === 'start') {
      started = 'runtime_stalled1';
      stalled.emit(replyTo, { version: 1, requestId: request.requestId, method: 'start', success: true, data: { runId: started, state: 'running' } });
    }
    // status never replies: poll stalls until the deadline.
  });
  const client = new LeafRuntimeClient({ events: stalled, modelId: MODEL, pollIntervalMs: 5 });
  try {
    await assert.rejects(() => client.runLeaf('stalls', { timeoutMs: 300 }), /timed out/);
    const cancel = stalled.requests().find((entry) => (entry as { method: string }).method === 'cancelAndSettle') as
      | { params: { runIds: string[] } }
      | undefined;
    assert.ok(cancel !== undefined, 'cancelAndSettle attempted after timeout');
    assert.ok(cancel.params.runIds.includes(started));
  } finally {
    client.dispose();
  }
  void bus;
});

test('malformed replies reject without leaking payload', async () => {
  const cases: Array<{ name: string; reply: (requestId: string) => unknown; match: RegExp }> = [
    { name: 'wrong version', reply: (id) => ({ version: 2, requestId: id, method: 'negotiate', success: true, data: {} }), match: /Malformed/ },
    { name: 'unknown error code', reply: (id) => ({ version: 1, requestId: id, success: false, error: { code: 'pwned_CODE', message: 'SECRET-MARKER' } }), match: /Malformed/ },
    { name: 'missing fields', reply: (id) => ({ version: 1, requestId: id, method: 'negotiate' }), match: /Malformed/ },
    { name: 'unknown method', reply: (id) => ({ version: 1, requestId: id, method: 'eval', success: true, data: {} }), match: /Malformed/ },
    { name: 'method mismatch', reply: (id) => ({ version: 1, requestId: id, method: 'start', success: true, data: {} }), match: /Malformed/ },
    {
      name: 'oversize',
      reply: (id) => ({ version: 1, requestId: id, method: 'negotiate', success: true, data: { blob: `SECRET-MARKER-${'x'.repeat(RUNTIME_RPC_BOUNDS.maxResultBytes)}` } }),
      match: /Malformed/,
    },
  ];
  for (const entry of cases) {
    const bus = new FakeBus();
    bus.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
      const request = raw as { requestId: string };
      bus.emit(runtimeRpcReplyEvent(request.requestId), entry.reply(request.requestId));
    });
    const client = new LeafRuntimeClient({ events: bus, modelId: MODEL });
    try {
      await assert.rejects(() => client.request('negotiate', { modelId: MODEL }, { timeoutMs: 2000 }), entry.match, entry.name);
    } finally {
      client.dispose();
    }
  }
  // Rejection messages never carry payload bytes.
  const bus = new FakeBus();
  bus.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
    const request = raw as { requestId: string };
    bus.emit(runtimeRpcReplyEvent(request.requestId), {
      version: 1,
      requestId: request.requestId,
      success: false,
      error: { code: 'no-such-code', message: 'SECRET-MARKER-LEAK-PROBE' },
    });
  });
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL });
  try {
    const error = await client.request('negotiate', { modelId: MODEL }, { timeoutMs: 2000 }).then(
      () => assert.fail('must reject'),
      (caught: Error) => caught,
    );
    assert.ok(!error.message.includes('SECRET-MARKER-LEAK-PROBE'));
  } finally {
    client.dispose();
  }
});

test('late reply after timeout is ignored; duplicate replies settle once', async () => {
  const bus = new FakeBus();
  let captured = '';
  bus.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
    captured = (raw as { requestId: string }).requestId;
  });
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL });
  try {
    const pending = client.request('negotiate', { modelId: MODEL }, { timeoutMs: 100 });
    await assert.rejects(() => pending, /timed out/);
    // Late reply on the (now unsubscribed) channel: no throw, no side effect.
    bus.emit(runtimeRpcReplyEvent(captured), { version: 1, requestId: captured, method: 'negotiate', success: true, data: {} });
    // Duplicate-reply case: first reply wins, second ignored.
    const bus2 = new FakeBus();
    bus2.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
      const request = raw as { requestId: string };
      const channel = runtimeRpcReplyEvent(request.requestId);
      bus2.emit(channel, { version: 1, requestId: request.requestId, method: 'negotiate', success: true, data: { n: 1 } });
      bus2.emit(channel, { version: 1, requestId: request.requestId, method: 'negotiate', success: true, data: { n: 2 } });
    });
    const client2 = new LeafRuntimeClient({ events: bus2, modelId: MODEL });
    try {
      const data = (await client2.request('negotiate', { modelId: MODEL }, { timeoutMs: 2000 })) as { n: number };
      assert.equal(data.n, 1);
    } finally {
      client2.dispose();
    }
  } finally {
    client.dispose();
  }
});

test('dispose clears pending, subscriptions, and rejects fail-closed', async () => {
  const bus = new FakeBus();
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL });
  try {
    const pending = client.request('negotiate', { modelId: MODEL }, { timeoutMs: 30_000 });
    assert.ok(bus.subscriptionCount() > 0);
    client.dispose();
    await assert.rejects(() => pending, /disposed/);
    assert.equal(bus.subscriptionCount(), 0);
    await assert.rejects(() => client.request('negotiate', { modelId: MODEL }), /disposed/);
    assert.equal(await client.refreshReady(), false);
  } finally {
    client.dispose();
  }
});

test('client-side bounds reject, never clamp', async () => {
  const bus = new FakeBus();
  stubServer(bus);
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL, pollIntervalMs: 5 });
  try {
    const bigPrompt = 'x'.repeat(RUNTIME_RPC_BOUNDS.maxPromptBytes + 1);
    await assert.rejects(() => client.runLeaf(bigPrompt, { timeoutMs: 1000 }), /byte limit/);
    assert.equal(bus.requests().length, 0, 'oversize prompt must not emit');
    await assert.rejects(
      () => client.request('negotiate', { modelId: MODEL }, { timeoutMs: RUNTIME_RPC_BOUNDS.maxTimeoutMs + 1 }),
      /exceeds maximum/,
    );
    // Emitted envelopes validate against the strict request validator.
    await client.request('negotiate', { modelId: MODEL }, { timeoutMs: 5000 });
    assert.ok(bus.requests().length > 0);
  } finally {
    client.dispose();
  }
});

test('result over byte limit rejects with safe code', async () => {
  const bus = new FakeBus();
  bus.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
    const request = raw as { requestId: string; method: string };
    const replyTo = runtimeRpcReplyEvent(request.requestId);
    if (request.method === 'negotiate') {
      bus.emit(replyTo, { version: 1, requestId: request.requestId, method: 'negotiate', success: true, data: { compatible: true, modelId: MODEL } });
    } else if (request.method === 'start') {
      bus.emit(replyTo, { version: 1, requestId: request.requestId, method: 'start', success: true, data: { runId: 'runtime_big1', state: 'running' } });
    } else if (request.method === 'status') {
      bus.emit(replyTo, { version: 1, requestId: request.requestId, method: 'status', success: true, data: { runId: 'runtime_big1', state: 'completed', startedAt: 1, updatedAt: 2 } });
    } else if (request.method === 'result') {
      // Output just under the reply-envelope bound but over the client result cap is
      // impossible (same bound); use output within envelope that still trips the cap
      // by shrinking the cap path: here output exceeds maxResultBytes so the reply
      // validator itself rejects — still a safe fail-closed rejection.
      bus.emit(replyTo, { version: 1, requestId: request.requestId, method: 'result', success: true, data: { runId: 'runtime_big1', state: 'completed', output: 'y'.repeat(RUNTIME_RPC_BOUNDS.maxResultBytes), outputTokens: 1, truncated: false } });
    }
  });
  const client = new LeafRuntimeClient({ events: bus, modelId: MODEL, pollIntervalMs: 5 });
  try {
    await assert.rejects(() => client.runLeaf('big', { timeoutMs: 10_000 }), /Malformed|byte limit/);
  } finally {
    client.dispose();
  }
});
