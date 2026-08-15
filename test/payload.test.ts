import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProviderPayload } from '../src/payload.js';

test('normalizeProviderPayload leaves string instructions unchanged', () => {
  const payload = { instructions: 'hello', input: [] };

  assert.deepEqual(normalizeProviderPayload(payload), payload);
});

test('normalizeProviderPayload converts object instructions to text', () => {
  const payload = { instructions: { text: 'hello' }, input: [] };

  assert.deepEqual(normalizeProviderPayload(payload), { instructions: 'hello', input: [] });
});

test('normalizeProviderPayload joins array instructions', () => {
  const payload = { instructions: [{ text: 'alpha' }, 'beta'], input: [] };

  assert.deepEqual(normalizeProviderPayload(payload), { instructions: 'alpha\nbeta', input: [] });
});

test('normalizeProviderPayload converts nested instructions arrays', () => {
  const payload = {
    body: {
      instructions: [{ text: 'alpha' }, { content: 'beta' }],
      input: [{ role: 'user', content: 'hello' }],
    },
  };

  assert.deepEqual(normalizeProviderPayload(payload), {
    body: {
      instructions: 'alpha\nbeta',
      input: [{ role: 'user', content: 'hello' }],
    },
  });
});

test('normalizeProviderPayload preserves instructions fields inside tool schemas', () => {
  const instructionsSchema = {
    type: 'string',
    description: "Server name to show that server's usage instructions",
  };
  const payload = {
    instructions: [{ text: 'system prompt' }],
    tools: [{
      type: 'function',
      name: 'mcp',
      parameters: {
        type: 'object',
        properties: { instructions: instructionsSchema },
      },
    }],
  };

  assert.deepEqual(normalizeProviderPayload(payload), {
    instructions: 'system prompt',
    tools: [{
      type: 'function',
      name: 'mcp',
      parameters: {
        type: 'object',
        properties: { instructions: instructionsSchema },
      },
    }],
  });
});

test('normalizeProviderPayload does not mutate a nested provider payload', () => {
  const payload = {
    body: {
      instructions: [{ text: 'alpha' }, { content: 'beta' }],
      input: [],
    },
  };

  normalizeProviderPayload(payload);

  assert.deepEqual(payload, {
    body: {
      instructions: [{ text: 'alpha' }, { content: 'beta' }],
      input: [],
    },
  });
});
