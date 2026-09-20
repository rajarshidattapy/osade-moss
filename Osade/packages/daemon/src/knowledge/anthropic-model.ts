import type { ModelPort, ModelRequest } from './model.js';

/**
 * A `ModelPort` backed by the Anthropic Messages API — OSADE.md §13.4.
 *
 * **The key is never written to disk.** Read from the environment at each use site and held only
 * in the process, exactly as §2.1 requires of the GitHub token. Nothing under `~/.osade/` ever
 * contains it, and `process.env` is read at the call rather than snapshotted at import so a
 * daemon started before the key was set picks it up on the next run (§20.1).
 *
 * Plain `fetch` rather than an SDK: this is one POST, and the alternative is a dependency whose
 * surface is far larger than the thing being used.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Per-pass models.
 *
 * Extraction runs once per pull request — three hundred calls on a default sample — and its job
 * is quotation, not judgement. Clustering and verification run once per candidate and are where
 * the reasoning actually happens. Matching the model to the job is the difference between mining
 * a repository for cents and for tens of dollars.
 */
export const DEFAULT_MODELS: Record<ModelRequest['pass'], string> = {
  extract: 'claude-haiku-4-5-20251001',
  cluster: 'claude-sonnet-5',
  verify: 'claude-sonnet-5',
};

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'mining needs an Anthropic API key. Set OSADE_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) ' +
        'in the daemon’s environment; Osade never writes it to disk.',
    );
    this.name = 'MissingApiKeyError';
  }
}

export class ModelApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`model API returned ${status}: ${detail}`);
    this.name = 'ModelApiError';
    this.status = status;
  }
}

/** True when mining is possible at all. The UI asks before offering the button. */
export function hasApiKey(): boolean {
  return apiKey() !== null;
}

function apiKey(): string | null {
  const key = process.env.OSADE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  return key && key.trim().length > 0 ? key : null;
}

export interface AnthropicModelOptions {
  models?: Partial<Record<ModelRequest['pass'], string>>;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  onWarning?: (message: string) => void;
}

interface MessagesResponse {
  content: { type: string; text?: string }[];
}

export class AnthropicModel implements ModelPort {
  readonly #models: Record<ModelRequest['pass'], string>;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #onWarning: (message: string) => void;

  constructor(options: AnthropicModelOptions = {}) {
    this.#models = { ...DEFAULT_MODELS, ...options.models };
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#onWarning = options.onWarning ?? (() => {});
  }

  async complete(request: ModelRequest): Promise<string> {
    const key = apiKey();
    if (!key) throw new MissingApiKeyError();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        return await this.#post(key, request);
      } catch (error) {
        lastError = error as Error;
        // 429 and 5xx are the transient ones; anything else is a bug in the request and
        // retrying it just spends money on the same mistake.
        const status = error instanceof ModelApiError ? error.status : 0;
        if (status !== 429 && status < 500) throw error;
        if (attempt === this.#maxRetries) break;

        const delay = 1_000 * 2 ** attempt;
        this.#onWarning(`${request.pass} pass: ${lastError.message}; retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
    throw lastError ?? new Error('model call failed');
  }

  async #post(key: string, request: ModelRequest): Promise<string> {
    const response = await this.#fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: this.#models[request.pass],
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
    });

    if (!response.ok) {
      throw new ModelApiError(response.status, await response.text().catch(() => ''));
    }

    const payload = (await response.json()) as MessagesResponse;
    return payload.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
