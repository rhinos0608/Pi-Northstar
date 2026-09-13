export function normalizeProviderPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;

  const normalized = normalizeRequestInstructions(payload);
  if (!isRecord(normalized.body)) return normalized;

  const body = normalizeRequestInstructions(normalized.body);
  if (body === normalized.body) return normalized;
  return { ...normalized, body };
}

function normalizeRequestInstructions(request: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(request, 'instructions')) return request;
  return { ...request, instructions: stringifyInstructions(request.instructions) };
}

function stringifyInstructions(instructions: unknown): string {
  if (instructions === undefined || instructions === null) return '';
  if (typeof instructions === 'string') return instructions;

  if (Array.isArray(instructions)) {
    return instructions.map(stringifyInstructions).filter(Boolean).join('\n');
  }

  if (isRecord(instructions)) {
    const text = instructions.text ?? instructions.content ?? instructions.instructions;
    if (typeof text === 'string') return text;
  }

  return JSON.stringify(instructions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
