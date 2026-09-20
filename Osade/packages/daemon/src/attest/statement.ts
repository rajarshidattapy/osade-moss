/**
 * The attestation statement — OSADE-MOSS §M.7.2.
 *
 * **The bytes are the artefact.** A signature covers exactly these bytes, so canonicalisation
 * is not a formatting preference: it is the difference between a signature that verifies on
 * another machine and one that does not. Sorted keys, no whitespace, `v` first.
 *
 * What a tier-1 statement claims, precisely: *this Osade instance attests that the GitHub user
 * it authenticated approved this exact commit after these checks passed.* It does **not** claim
 * that the approver signed anything — that is tier 2, where the approver's own SSH key signs on
 * their device and the verifier checks it against `github.com/<login>.keys`. The tier is in the
 * statement so a reader is never left guessing which claim they are looking at.
 */

export interface VerificationRecord {
  readonly step: string;
  readonly cmd: string;
  readonly exit: number;
  readonly head_sha: string;
}

export interface StatementContext {
  readonly conventions_injected: number;
  readonly policy_clauses_shown: readonly string[];
  readonly clauses_acked: readonly string[];
}

export interface AttestationStatement {
  readonly v: 1;
  readonly tier: 1 | 2;
  readonly repo: string;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly gate: { readonly id: string; readonly name: string; readonly payload_hash: string };
  readonly approved_by: string;
  readonly approved_at: string;
  readonly verification: readonly VerificationRecord[];
  readonly context: StatementContext;
  readonly agent: string;
  readonly osade_build: string;
}

/**
 * Canonical JSON: `v` first, then every other key sorted, no whitespace.
 *
 * `v` leads so a verifier can read the version without parsing the whole document — which
 * matters the day a v2 exists and an old verifier meets one.
 */
export function canonicalise(statement: AttestationStatement): string {
  const { v, ...rest } = statement as AttestationStatement & Record<string, unknown>;
  return `{"v":${JSON.stringify(v)},${stableEntries(rest)}}`;
}

function stableEntries(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
    .join(',');
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${stableEntries(value as Record<string, unknown>)}}`;
}

export function parseStatement(json: string): AttestationStatement | null {
  try {
    const parsed = JSON.parse(json) as AttestationStatement;
    if (parsed?.v !== 1 || typeof parsed.head_sha !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** §M.7.3 — the markers the PR body block sits between. */
export const BLOCK_OPEN = '<!-- osade-attestation v1 -->';
export const BLOCK_CLOSE = '<!-- /osade-attestation -->';

export interface AttestationBlock {
  readonly statement: string;
  readonly signature: string;
  readonly keyId: string;
}

/**
 * Renders the block that goes in the PR body.
 *
 * The statement is base64 so that Markdown rendering, line wrapping and a reviewer's editor
 * cannot alter the bytes the signature covers. The human-readable line above it is for people;
 * the base64 is for `osade attest verify`, and neither is derived from the other at read time.
 */
export function renderBlock(
  statement: AttestationStatement,
  signature: string,
  keyId: string,
): string {
  const canonical = canonicalise(statement);
  const shortSha = statement.head_sha.slice(0, 7);
  const checks = statement.verification.map((record) => `\`${record.cmd}\``).join(', ');
  const human =
    `Approved by @${statement.approved_by.replace(/^github:/, '')} for commit ${shortSha}` +
    `${checks ? ` after ${checks} passed` : ''}. Signed by Osade (tier ${statement.tier}).`;

  return [
    BLOCK_OPEN,
    '',
    human,
    '',
    '```',
    `statement: ${Buffer.from(canonical, 'utf8').toString('base64')}`,
    `signature: ${signature}`,
    `key_id: ${keyId}`,
    '```',
    '',
    // Say the limit out loud, in the place a maintainer will read it. §M.7.2 is explicit that
    // a tier-1 attestation trusts the daemon's operator, and hiding that would make the block
    // claim more than it can.
    statement.tier === 1
      ? '<sub>Tier 1: this Osade install vouches for the approver it authenticated. It does not' +
        ' prove the approver signed anything themselves.</sub>'
      : '<sub>Tier 2: signed on the approver’s device with a key published on their GitHub account.</sub>',
    BLOCK_CLOSE,
  ].join('\n');
}

/** Pulls the block back out of a PR body. Null when there is none, or it is malformed. */
export function parseBlock(body: string): AttestationBlock | null {
  const start = body.indexOf(BLOCK_OPEN);
  if (start === -1) return null;
  const end = body.indexOf(BLOCK_CLOSE, start);
  const region = end === -1 ? body.slice(start) : body.slice(start, end);

  const statement = /^statement:\s*(\S+)\s*$/m.exec(region)?.[1];
  const signature = /^signature:\s*(\S+)\s*$/m.exec(region)?.[1];
  const keyId = /^key_id:\s*(\S+)\s*$/m.exec(region)?.[1];
  if (!statement || !signature || !keyId) return null;

  try {
    return {
      statement: Buffer.from(statement, 'base64').toString('utf8'),
      signature,
      keyId,
    };
  } catch {
    return null;
  }
}

/**
 * Replaces an existing block, or appends one.
 *
 * A PR updated after a fresh approval carries one attestation, not a pile of them: the current
 * one is the only one that means anything, and a stack of superseded blocks would invite a
 * reader to check the wrong one.
 */
export function withBlock(body: string, block: string): string {
  const start = body.indexOf(BLOCK_OPEN);
  if (start === -1) return `${body.trimEnd()}\n\n---\n${block}\n`;
  const end = body.indexOf(BLOCK_CLOSE, start);
  const tail = end === -1 ? '' : body.slice(end + BLOCK_CLOSE.length);
  return `${body.slice(0, start)}${block}${tail}`;
}
