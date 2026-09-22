import type { AuditRow } from '@osade/contract';

import type { Db } from '../db/index.js';

/**
 * The audit export — OSADE-MOSS §M.8.4.
 *
 * The row shape lives in `@osade/contract` rather than here, because §5.5 makes the contract
 * the only cross-boundary type and an export is nothing *but* a boundary: the shape a
 * compliance reader receives has to be the shape the procedure declares.
 *
 * **Nothing in this export is computed by a model. Every field is a stored fact or a hash of
 * one.** That sentence is the feature. An export that contained a summary, a risk rating or a
 * judgement would be inadmissible as evidence of anything, because the reader could not tell
 * which parts were recorded and which were inferred.
 *
 * It is a read-only projection: a query, a shape, and no writes. Running it twice over the same
 * window produces the same bytes, which is what makes it something you can attach to a ticket.
 */

export interface AuditOptions {
  readonly since: number;
  readonly until?: number;
  /** Narrow to one repository. Absent means everything in the window. */
  readonly repoId?: string;
}

/**
 * Every gate in the window, with what surrounded it.
 *
 * Gate-shaped rather than task-shaped because the question an auditor asks is "who approved
 * what, and on what basis" — one row per decision, not one per task with decisions nested
 * inside it.
 */
export function auditExport(db: Db, options: AuditOptions): AuditRow[] {
  const until = options.until ?? Number.MAX_SAFE_INTEGER;
  const gates = db
    .prepare(
      `SELECT g.id, g.gate, g.task_id, g.payload_json, g.payload_hash, g.requested_at,
              g.decided_at, g.decision, g.decided_by, g.executed_at, g.execution_error,
              t.repo_id, r.gh_owner, r.gh_name, r.path
         FROM gate_request g
         JOIN task t ON t.id = g.task_id
         JOIN repo r ON r.id = t.repo_id
        WHERE g.requested_at >= ? AND g.requested_at <= ?
          AND (? IS NULL OR t.repo_id = ?)
        ORDER BY g.requested_at ASC`,
    )
    .all(options.since, until, options.repoId ?? null, options.repoId ?? null) as GateRow[];

  return gates.map((gate) => {
    const headSha = headOf(gate.payload_json);
    return {
      gate_id: gate.id,
      gate: gate.gate,
      repo: gate.gh_owner && gate.gh_name ? `${gate.gh_owner}/${gate.gh_name}` : gate.path,
      task_id: gate.task_id,
      requested_at: iso(gate.requested_at),
      decided_at: gate.decided_at == null ? null : iso(gate.decided_at),
      decision: gate.decision,
      decided_by: gate.decided_by,
      payload_hash: gate.payload_hash,
      head_sha: headSha,
      executed_at: gate.executed_at == null ? null : iso(gate.executed_at),
      execution_error: gate.execution_error,
      // Scoped to the commit that was approved. Runs at another head verified other code.
      verification: headSha ? verificationFor(db, gate.task_id, headSha) : [],
      clauses_shown: clausesFor(db, gate.id),
      clauses_acked: acksFor(db, gate.id),
      ...attestationFor(db, gate.id),
    };
  });
}

/** JSON Lines — one self-contained record per line, so a partial file is still readable. */
export function toJsonl(rows: readonly AuditRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * CSV, for the spreadsheet an auditor will actually open.
 *
 * The nested fields are flattened to counts and joined refs rather than dropped: a column that
 * says `SEC-3.2;SEC-4.1` is answerable, and a missing column is not.
 */
export function toCsv(rows: readonly AuditRow[]): string {
  const header = [
    'gate_id', 'gate', 'repo', 'task_id', 'requested_at', 'decided_at', 'decision', 'decided_by',
    'payload_hash', 'head_sha', 'executed_at', 'execution_error', 'verification_steps',
    'verification_failed', 'clauses_shown', 'clauses_acked', 'attestation_id', 'attestation_key_id',
  ];

  const lines = rows.map((row) =>
    [
      row.gate_id,
      row.gate,
      row.repo,
      row.task_id,
      row.requested_at,
      row.decided_at ?? '',
      row.decision ?? '',
      row.decided_by ?? '',
      row.payload_hash,
      row.head_sha ?? '',
      row.executed_at ?? '',
      row.execution_error ?? '',
      row.verification.map((v) => `${v.step}=${v.exit ?? '?'}`).join(';'),
      String(row.verification.filter((v) => v.exit !== 0).length),
      row.clauses_shown.map((c) => c.ref).join(';'),
      row.clauses_acked.map((c) => c.ref).join(';'),
      row.attestation_id ?? '',
      row.attestation_key_id ?? '',
    ].map(csvCell).join(','),
  );

  return [header.join(','), ...lines].join('\n') + '\n';
}

interface GateRow {
  id: string;
  gate: string;
  task_id: string;
  payload_json: string;
  payload_hash: string;
  requested_at: number;
  decided_at: number | null;
  decision: string | null;
  decided_by: string | null;
  executed_at: number | null;
  execution_error: string | null;
  repo_id: string;
  gh_owner: string | null;
  gh_name: string | null;
  path: string;
}

function verificationFor(
  db: Db,
  taskId: string,
  headSha: string,
): { step: string; cmd: string; exit: number | null }[] {
  const rows = db
    .prepare(
      `SELECT step_name, cmd, exit_code FROM verify_run
        WHERE task_id = ? AND head_sha = ? AND finished_at IS NOT NULL
        ORDER BY started_at ASC`,
    )
    .all(taskId, headSha) as { step_name: string; cmd: string; exit_code: number | null }[];
  return rows.map((row) => ({ step: row.step_name, cmd: row.cmd, exit: row.exit_code }));
}

function clausesFor(db: Db, gateId: string): { ref: string; policy: string; file_sha: string }[] {
  const rows = db
    .prepare(
      // M18 — read from the snapshot, never joined to `policy`: the current policy is not the
      // one that was shown, and a deleted one would drop the row entirely.
      `SELECT clause_ref, policy_path AS path, file_sha FROM gate_clause
        WHERE gate_id = ? ORDER BY clause_ref`,
    )
    .all(gateId) as { clause_ref: string; path: string; file_sha: string }[];
  // The file_sha travels with the ref: "SEC-3.2 applied" is only checkable against the version
  // of the policy that was shown.
  return rows.map((row) => ({ ref: row.clause_ref, policy: row.path, file_sha: row.file_sha }));
}

function acksFor(db: Db, gateId: string): { ref: string; by: string; at: string }[] {
  const rows = db
    .prepare(
      `SELECT clause_ref, acked_by, acked_at FROM gate_clause
        WHERE gate_id = ? AND acked_at IS NOT NULL ORDER BY clause_ref`,
    )
    .all(gateId) as { clause_ref: string; acked_by: string; acked_at: number }[];
  return rows.map((row) => ({
    ref: row.clause_ref,
    by: row.acked_by,
    at: iso(row.acked_at),
  }));
}

function attestationFor(
  db: Db,
  gateId: string,
): {
  attestation_id: string | null;
  attestation_signature: string | null;
  attestation_key_id: string | null;
} {
  const row = db
    .prepare('SELECT id, signature, key_id FROM attestation WHERE gate_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(gateId) as { id: string; signature: string; key_id: string } | undefined;
  return {
    attestation_id: row?.id ?? null,
    attestation_signature: row?.signature ?? null,
    attestation_key_id: row?.key_id ?? null,
  };
}

function headOf(payloadJson: string): string | null {
  try {
    const parsed = JSON.parse(payloadJson) as { head_sha?: unknown };
    return typeof parsed.head_sha === 'string' ? parsed.head_sha : null;
  } catch {
    return null;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type { AuditRow };
