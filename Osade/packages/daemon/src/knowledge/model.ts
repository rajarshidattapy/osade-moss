import { z } from 'zod';

/**
 * The model port — OSADE.md §13.4.
 *
 * Osade's agents run as real processes under the substrate; this is the one place the daemon itself
 * talks to a model, and it is deliberately the narrowest possible surface: a system prompt, a
 * user prompt, a token ceiling, text back. No streaming, no tools, no conversation.
 *
 * It is a port rather than a client because the miner's correctness must be testable without a
 * network or an API key. Every threshold in §13.4 is enforced in `miner.ts` over the model's
 * output; the model proposes, the code decides.
 */
export interface ModelPort {
  complete(request: ModelRequest): Promise<string>;
}

export interface ModelRequest {
  /** Names the pass, so a caller can log or budget per pass. */
  pass: 'extract' | 'cluster' | 'verify';
  system: string;
  user: string;
  maxOutputTokens: number;
}

export class ModelOutputError extends Error {
  constructor(pass: string, detail: string) {
    super(`${pass} pass returned unusable output: ${detail}`);
    this.name = 'ModelOutputError';
  }
}

/**
 * Calls a pass and validates its output against a schema.
 *
 * A model that returns something unparseable is a failed pass, not a silent empty result:
 * mining that quietly produces nothing looks identical to a repository with no conventions, and
 * those two need to be distinguishable in `mine_run.error`.
 */
export async function callPass<T>(
  model: ModelPort,
  request: ModelRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await model.complete(request);
  const json = extractJson(raw);
  if (json === null) throw new ModelOutputError(request.pass, 'no JSON found in the response');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ModelOutputError(request.pass, (error as Error).message);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ModelOutputError(request.pass, result.error.issues.map(describe).join('; '));
  }
  return result.data;
}

function describe(issue: z.ZodIssue): string {
  return `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

/**
 * Pulls the JSON body out of a response.
 *
 * Models fence JSON, preface it, or return it bare. Rather than demanding one shape in the
 * prompt and failing the whole pass when the model adds a sentence, this finds the outermost
 * object or array. Anything past the closing brace is ignored.
 */
export function extractJson(raw: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(raw);
  const body = fenced?.[1] ?? raw;

  const start = firstIndexOfEither(body, '{', '[');
  if (start === -1) return null;

  const open = body[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) return null;

  return body.slice(start, end + 1);
}

function firstIndexOfEither(s: string, a: string, b: string): number {
  const ia = s.indexOf(a);
  const ib = s.indexOf(b);
  if (ia === -1) return ib;
  if (ib === -1) return ia;
  return Math.min(ia, ib);
}

/**
 * Truncates prompt input to a character budget on a line boundary.
 *
 * Every pass has a bounded input by construction — §13.4's "do not build one mega-prompt" is
 * about attention, and a single 40k-token review thread defeats the point as thoroughly as
 * concatenating all three passes would.
 */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  const body = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${body}\n… [truncated]`;
}

/** Rough, and deliberately so — used only for the §13.5 injection budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
