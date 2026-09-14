// Plan D task D2: OpenAI-compatible vision transport (operator-configured
// endpoint, never called "local").
//
// Accepts any configured base URL (loopback or cloud) plus exact operator
// model IDs plus an optional API key. Speaks the OpenAI chat-completions
// shape (`POST {baseUrl}/chat/completions` with an `image_url` data-URL part)
// so loopback servers (Ollama, LM Studio, vLLM) and cloud OpenAI-compatible
// endpoints share one path. Byte bounds plus post-response usage checks only:
// this transport never claims preflight token enforcement (per master-plan
// ceilings, arbitrary endpoints must not claim preflight).

/** Operator env: endpoint base URL (loopback or cloud), exact value used. */
export const OPENAI_COMPAT_BASE_URL_ENV_VAR = 'PI_VISION_OPENAI_COMPAT_BASE_URL';

/** Operator env: comma-separated exact model IDs, no normalization. */
export const OPENAI_COMPAT_MODEL_ENV_VAR = 'PI_VISION_OPENAI_COMPAT_MODEL';

/** Operator env: optional bearer key; absent means keyless (loopback use). */
export const OPENAI_COMPAT_API_KEY_ENV_VAR = 'PI_VISION_OPENAI_COMPAT_API_KEY';

export type VisionEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Operator vision config: exact base URL + exact model IDs + optional key. */
export interface OpenAICompatibleVisionConfig {
  baseUrl: string;
  modelIds: readonly string[];
  apiKey?: string;
}

/** Hard bound on a single image payload accepted by this transport. */
export const VISION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Default per-request timeout (ms) when the caller sets none. */
export const VISION_REQUEST_TIMEOUT_MS = 60_000;

function trimValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Parses the exact-model-ID list: split on comma, trim, drop empties. */
export function parseVisionModelIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** True only when the base URL is http(s) (loopback included). */
export function isVisionBaseUrlAllowed(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolves the operator config, or null when unconfigured. Requires an
 * http(s) base URL plus at least one exact model ID; the key stays optional
 * so keyless loopback endpoints work. Malformed config returns null (fail
 * closed) rather than guessing.
 */
export function resolveOpenAICompatibleVisionConfig(
  env: VisionEnv = process.env,
): OpenAICompatibleVisionConfig | null {
  const baseUrl = trimValue(env[OPENAI_COMPAT_BASE_URL_ENV_VAR]);
  if (!baseUrl || !isVisionBaseUrlAllowed(baseUrl)) return null;
  const modelIds = parseVisionModelIds(env[OPENAI_COMPAT_MODEL_ENV_VAR]);
  if (modelIds.length === 0) return null;
  const apiKey = trimValue(env[OPENAI_COMPAT_API_KEY_ENV_VAR]);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    modelIds,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** True when a usable operator config resolves from the environment. */
export function isOpenAICompatibleVisionConfigured(env: VisionEnv = process.env): boolean {
  return resolveOpenAICompatibleVisionConfig(env) !== null;
}

/** One vision describe call: image bytes plus prompt plus exact model ID. */
export interface VisionDescribeRequest {
  imageBytes: Uint8Array;
  mimeType: string;
  prompt: string;
  modelId: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** Transport outcome. Usage is post-response observation, never preflight. */
export interface VisionDescribeResult {
  ok: boolean;
  text?: string;
  error?: string;
  /** Model-reported usage when the endpoint returns it, else undefined. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export type VisionFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Builds a transport bound to one operator config. The caller picks the exact
 * model ID per call (from `config.modelIds`); this transport never invents or
 * rewrites model names. Pass a custom `fetchFn` in tests to avoid network.
 */
export function createOpenAICompatibleVisionTransport(config: OpenAICompatibleVisionConfig) {
  async function describe(
    request: VisionDescribeRequest,
    fetchFn?: VisionFetchFn,
  ): Promise<VisionDescribeResult> {
    if (!request.modelId || !config.modelIds.includes(request.modelId)) {
      return { ok: false, error: 'unsupported_model' };
    }
    if (!(request.imageBytes instanceof Uint8Array) || request.imageBytes.byteLength === 0) {
      return { ok: false, error: 'invalid_input' };
    }
    if (request.imageBytes.byteLength > VISION_IMAGE_MAX_BYTES) {
      return { ok: false, error: 'response_too_large' };
    }
    if (!request.prompt || request.prompt.trim().length === 0) {
      return { ok: false, error: 'invalid_input' };
    }
    const fetchImpl: VisionFetchFn =
      fetchFn ??
      (async (url, init) => {
        const response = await fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        });
        return { status: response.status, text: () => response.text() };
      });
    const dataUrl = `data:${request.mimeType || 'image/png'};base64,${Buffer.from(
      request.imageBytes.buffer,
      request.imageBytes.byteOffset,
      request.imageBytes.byteLength,
    ).toString('base64')}`;
    const body = JSON.stringify({
      model: request.modelId,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      ...(typeof request.maxOutputTokens === 'number'
        ? { max_tokens: request.maxOutputTokens }
        : {}),
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? VISION_REQUEST_TIMEOUT_MS,
    );
    // Never hold the event loop open for a hung upstream: unref the abort
    // timer (guarded so non-Node runtimes without unref still work).
    if (typeof (timeout as unknown as { unref?: unknown }).unref === 'function') {
      (timeout as unknown as { unref: () => void }).unref();
    }
    try {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: `upstream_error:${response.status}` };
      }
      let parsed: {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: Record<string, unknown>;
      };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        return { ok: false, error: 'transport_invalid_response' };
      }
      const content = parsed.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content
            .filter(
              (part): part is { type?: string; text?: string } =>
                typeof part === 'object' && part !== null,
            )
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text as string)
            .join('')
        : typeof content === 'string'
          ? content
          : '';
      if (!text || text.trim().length === 0) {
        return { ok: false, error: 'empty_vision_response' };
      }
      const usage = parsed.usage;
      const numeric = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      const result: VisionDescribeResult = { ok: true, text };
      if (usage && typeof usage === 'object') {
        const observed: NonNullable<VisionDescribeResult['usage']> = {};
        const promptTokens = numeric(usage.prompt_tokens);
        const completionTokens = numeric(usage.completion_tokens);
        const totalTokens = numeric(usage.total_tokens);
        if (promptTokens !== undefined) observed.promptTokens = promptTokens;
        if (completionTokens !== undefined) observed.completionTokens = completionTokens;
        if (totalTokens !== undefined) observed.totalTokens = totalTokens;
        if (Object.keys(observed).length > 0) result.usage = observed;
      }
      return result;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return { ok: false, error: 'timeout' };
      return { ok: false, error: 'transport_error' };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { config, describe };
}

export type OpenAICompatibleVisionTransport = ReturnType<
  typeof createOpenAICompatibleVisionTransport
>;
