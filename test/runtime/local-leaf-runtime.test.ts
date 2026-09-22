import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalLeafRuntime, LocalLeafRuntimeError, resolveLocalLeafModelId } from '../../src/runtime/local-leaf-runtime.js';

function completedModels() {
  return {
    getModel(provider: string, id: string) {
      return provider === 'test' && id === 'model'
        ? { provider, id, maxTokens: 4096 }
        : undefined;
    },
    async refresh() {},
    async completeSimple() {
      return {
        role: 'assistant',
        content: [{ type: 'text', text: 'local result' }],
        usage: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      };
    },
  };
}

async function waitForState(runtime: LocalLeafRuntime, runId: string, target: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const status = await runtime.request('status', { runId }) as { state: string };
    if (status.state === target) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`run did not reach ${target}`);
}

test('resolveLocalLeafModelId treats explicit malformed unified env as authoritative failure', () => {
  assert.equal(
    resolveLocalLeafModelId({
      PI_NORTHSTAR_MODEL: 'not-an-exact-model',
      PI_NORTHSTAR_LEAF_MODEL: 'legacy/fallback',
    }),
    undefined,
  );
  assert.equal(
    resolveLocalLeafModelId({ PI_NORTHSTAR_LEAF_MODEL: 'legacy/fallback' }),
    'legacy/fallback',
  );
});

test('LocalLeafRuntime negotiates exact models and completes a local run', async () => {
  const runtime = new LocalLeafRuntime({ models: completedModels() as never, env: {} });
  try {
    const negotiated = await runtime.request('negotiate', { modelId: 'test/model' }) as { compatible: boolean; modelId: string };
    assert.deepEqual({ compatible: negotiated.compatible, modelId: negotiated.modelId }, { compatible: true, modelId: 'test/model' });

    const started = await runtime.request('start', {
      modelId: 'test/model',
      prompt: 'hello',
      maxOutputTokens: 16,
      timeoutMs: 1_000,
      correlation: { owner: 'northstar' },
    }) as { runId: string; state: string };
    assert.match(started.runId, /^runtime_[A-Za-z0-9_-]+$/);
    assert.equal(started.state, 'running');

    await waitForState(runtime, started.runId, 'completed');
    const result = await runtime.request('result', { runId: started.runId });
    assert.deepEqual(result, {
      runId: started.runId,
      state: 'completed',
      output: 'local result',
      outputTokens: 3,
      truncated: false,
    });
  } finally {
    await runtime.dispose();
  }
});

test('LocalLeafRuntime treats pi-ai error messages as provider failures', async () => {
  const models = {
    ...completedModels(),
    async completeSimple() {
      return {
        role: 'assistant',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error',
        errorMessage: 'provider rejected credentials',
        timestamp: Date.now(),
      };
    },
  };
  const runtime = new LocalLeafRuntime({ models: models as never, env: {} });
  try {
    const started = await runtime.request('start', {
      modelId: 'test/model',
      prompt: 'hello',
      maxOutputTokens: 16,
      timeoutMs: 1_000,
      correlation: { owner: 'northstar' },
    }) as { runId: string };
    await waitForState(runtime, started.runId, 'failed');
    await assert.rejects(
      () => runtime.request('result', { runId: started.runId }),
      (error: unknown) => error instanceof LocalLeafRuntimeError && error.code === 'provider_error',
    );
  } finally {
    await runtime.dispose();
  }
});

test('LocalLeafRuntime preserves model_unavailable instead of inventing fallback', async () => {
  const runtime = new LocalLeafRuntime({ models: completedModels() as never, env: {} });
  try {
    await assert.rejects(
      () => runtime.request('negotiate', { modelId: 'missing/model' }),
      (error: unknown) => error instanceof LocalLeafRuntimeError && error.code === 'model_unavailable',
    );
  } finally {
    await runtime.dispose();
  }
});

test('LocalLeafRuntime cancellation aborts an active local run', async () => {
  const models = {
    ...completedModels(),
    async completeSimple(_model: unknown, _context: unknown, options: { signal?: AbortSignal }) {
      await new Promise<void>((_resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    },
  };
  const runtime = new LocalLeafRuntime({ models: models as never, env: {} });
  try {
    const started = await runtime.request('start', {
      modelId: 'test/model',
      prompt: 'block',
      maxOutputTokens: 16,
      timeoutMs: 10_000,
      correlation: { owner: 'northstar' },
    }) as { runId: string };

    const cancelled = await runtime.request('cancelAndSettle', {
      runIds: [started.runId],
      settlementWindowMs: 100,
    }) as { settlements: Array<{ runId: string; state: string }> };
    assert.deepEqual(cancelled.settlements, [{ runId: started.runId, state: 'cancelled' }]);
    const status = await runtime.request('status', { runId: started.runId }) as { state: string };
    assert.equal(status.state, 'cancelled');
  } finally {
    await runtime.dispose();
  }
});
