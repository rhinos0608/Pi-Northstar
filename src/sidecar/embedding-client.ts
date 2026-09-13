export interface EmbeddingClientOptions {
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface EmbeddingHealthResponse {
  status: string;
  model?: string | null;
  dimensions?: number | null;
  device?: string | null;
}

export class EmbeddingUnavailableError extends Error {
  /** HTTP status code when the error came from an HTTP response. */
  public status: number | undefined;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = 'EmbeddingUnavailableError';
    this.status = options?.status;
  }
}

const DEFAULT_BASE_URL = process.env.EMBEDDING_SIDECAR_BASE_URL ?? 'http://127.0.0.1:8765';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_INPUT_CHARS = 8192;
const RETRY_DELAY_MS = 1000;

/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
interface EmbeddingResponseData {
  embedding: number[];
  index: number;
  object: string;
}

/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
interface EmbeddingResponse {
  data: EmbeddingResponseData[];
  model: string;
  object: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingClient {
  private baseUrl: string;
  private timeout: number;
  private maxRetries: number;
  private signal: AbortSignal | undefined;
  private apiToken: string | undefined;

  constructor(options?: EmbeddingClientOptions) {
    this.baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(1, options?.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.signal = options?.signal;
    this.apiToken = process.env.EMBEDDING_SIDECAR_API_TOKEN || undefined;
  }

  async embed(text: string): Promise<Float32Array> {
    const truncated = text.slice(0, MAX_INPUT_CHARS);
    const data = await this.request<EmbeddingResponse>(
      `${this.baseUrl}/v1/embeddings`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ input: truncated }),
      },
    );
    return new Float32Array(data.data[0]!.embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const data = await this.request<EmbeddingResponse>(
      `${this.baseUrl}/v1/embeddings`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ input: texts.map((t) => t.slice(0, MAX_INPUT_CHARS)) }),
      },
    );
    return data.data.map((item) => new Float32Array(item.embedding));
  }

  async health(): Promise<EmbeddingHealthResponse> {
    return this.request<EmbeddingHealthResponse>(
      `${this.baseUrl}/v1/health`,
      { method: 'GET', headers: this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {} },
    );
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    return headers;
  }

  private async request<T>(url: string, options: RequestInit): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.doFetch<T>(url, options);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries && isRetryable(error)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }

    // Unreachable, but makes TS happy
    throw lastError;
  }

  private async doFetch<T>(url: string, options: RequestInit): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.timeout);
    const combinedSignal = this.signal
      ? AbortSignal.any([timeoutSignal, this.signal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, { ...options, signal: combinedSignal });
    } catch (error) {
      throw new EmbeddingUnavailableError(
        'Embedding request failed after retries',
        { cause: error },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new EmbeddingUnavailableError(
        `Embedding request failed: HTTP ${response.status} - ${text}`,
        { status: response.status },
      );
    }

    return response.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingUnavailableError) {
    // Retry 5xx and 429 (rate-limit) responses
    const status = error.status;
    if (status === undefined) return true; // transport/network failure
    return status >= 500 || status === 429;
  }
  // Network / fetch-level errors (ECONNREFUSED, DNS failures, timeouts, etc.)
  if (error instanceof Error && /abort|econnrefused|econnreset|enotfound|socket hang up|fetch failed|network/i.test(error.message)) {
    return true;
  }
  return false;
}
