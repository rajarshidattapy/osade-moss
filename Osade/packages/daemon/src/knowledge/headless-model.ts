import type { HeadlessRuns } from '../domain/headless-run.js';
import type { ModelPort, ModelRequest } from './model.js';

/**
 * ModelPort backed by a local coding agent — docs/agent_handler.md §2.
 *
 * Replaces Anthropic API keys. Callers that need JSON still prompt for JSON and parse defensively.
 */

export class HeadlessModel implements ModelPort {
  readonly #runs: HeadlessRuns;
  readonly #repoId: string;

  constructor(runs: HeadlessRuns, repoId: string) {
    this.#runs = runs;
    this.#repoId = repoId;
  }

  async complete(request: ModelRequest): Promise<string> {
    const { text } = await this.#runs.run({
      repoId: this.#repoId,
      prompt: `${request.system}\n\n${request.user}`,
      timeoutSec: request.pass === 'extract' ? 90 : 180,
    });
    return text;
  }
}
