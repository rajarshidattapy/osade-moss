#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDb } from '../src/db/index.js';
import { reloadPolicies } from '../src/knowledge/policies.js';

/**
 * Seed a smoke database with one task that reaches every panel.
 *
 * The renderer's panels — the gate card, the verification plan review, the PR flow, the
 * conventions list — only appear when the underlying facts exist. Nothing in `pnpm check` renders
 * them, so this makes them reachable by `pnpm --filter @osade/desktop smoke` and a screenshot.
 *
 * Writes facts directly, which is the point: §6 derives status at read time, so seeding *facts*
 * and seeing the right status appear is the invariant being checked, not a shortcut around it.
 *
 *   pnpm --filter @osade/daemon exec vite-node scripts/seed-smoke-fixture.mjs [osade-home]
 */

const home = resolve(process.argv[2] ?? join('apps', 'desktop', '.smoke'));
mkdirSync(home, { recursive: true });

// `openDb` migrates, so this works against a fresh directory as well as a booted one - which is
// what lets the panel check be a single command instead of boot-then-seed-then-boot.
const db = openDb(join(home, 'osade.db'));
const NOW = Date.now();

const payload = {
  title: 'Retry the flaky poller test',
  body: 'The poller test fails intermittently on slow machines. Adds a bounded retry.',
  head: 'osade/retry-flaky-poller',
  base: 'main',
  draft: false,
};
const payloadJson = JSON.stringify(payload);
const payloadHash = createHash('sha256').update(payloadJson).digest('hex');

db.exec('BEGIN');
try {
  db.prepare(
    `INSERT OR IGNORE INTO repo (id, path, default_branch, gh_owner, gh_name, created_at)
     VALUES ('r_smoke', '/repo/widget', 'main', 'acme', 'widget', ?)`,
  ).run(NOW);

  db.prepare(
    `INSERT OR REPLACE INTO task
       (id, repo_id, title, intent, origin_kind, base_ref, base_sha, branch, worktree_path,
        substrate_workspace_id, chat_id, created_at)
     VALUES ('t_smoke01', 'r_smoke', 'Retry the flaky poller test',
             'The poller test fails intermittently on slow machines.', 'manual',
             'main', 'c820293d7c52', 'osade/retry-flaky-poller', '/wt/t_smoke01', 'w3',
             't_smoke01', ?)`,
  ).run(NOW);

  // §6 row 3 — an undecided gate outranks everything, so this task reads awaiting_approval.
  db.prepare(
    `INSERT OR REPLACE INTO gate_request
       (id, task_id, gate, payload_json, payload_hash, requested_at)
     VALUES ('g_smoke01', 't_smoke01', 'gate.pr_open', ?, ?, ?)`,
  ).run(payloadJson, payloadHash, NOW);

  db.prepare(
    `INSERT OR REPLACE INTO agent_fact
       (task_id, substrate_pane_id, substrate_state, last_event, last_event_at, activity_text, pane_alive)
     VALUES ('t_smoke01', 'p7', 'working', 'to_review', ?, 'waiting on your approval', 1)`,
  ).run(NOW);

  // §10.1 — a confirmed plan, so the review panel shows steps rather than a derive button.
  const steps = [
    { name: 'typecheck', cmd: 'pnpm typecheck', cwd: '.', timeoutSec: 600, required: true, source: 'ci', evidence: '.github/workflows/ci.yml → check' },
    { name: 'test', cmd: 'pnpm test', cwd: '.', timeoutSec: 600, required: true, source: 'ci', evidence: '.github/workflows/ci.yml → check' },
    { name: 'build', cmd: 'pnpm build', cwd: '.', timeoutSec: 600, required: false, source: 'manifest', evidence: 'package.json scripts.build' },
  ];
  db.prepare(
    `INSERT OR REPLACE INTO verify_plan (repo_id, steps_json, needs_review, derived_at, confirmed_at)
     VALUES ('r_smoke', ?, 0, ?, ?)`,
  ).run(JSON.stringify(steps), NOW, NOW);

  // §13 — one active convention and one candidate, each with the evidence the UI must show.
  const conventions = [
    ['cv_smoke01', 'scope_limits', 'Keep each pull request to one concern.', 0.92, 'active'],
    ['cv_smoke02', 'test_requirements', 'Add a regression test with every bug fix.', 0.55, 'candidate'],
  ];
  for (const [id, category, ruleText, confidence, lifecycle] of conventions) {
    db.prepare(
      `INSERT OR REPLACE INTO convention
         (id, repo_id, category, rule_text, rationale, confidence, lifecycle, mined_at, last_confirmed_at)
       VALUES (?, 'r_smoke', ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(id, category, ruleText, confidence, lifecycle, NOW, NOW);

    db.prepare(
      `INSERT OR REPLACE INTO convention_evidence (id, convention_id, kind, url, excerpt, observed_at)
       VALUES (?, ?, 'rejected_pr', ?, ?, ?)`,
    ).run(`ce_${id}`, id, `https://github.com/acme/widget/pull/1234`, 'too many things at once', NOW);
    db.prepare(
      `INSERT OR REPLACE INTO convention_evidence (id, convention_id, kind, url, excerpt, observed_at)
       VALUES (?, ?, 'review_comment', ?, ?, ?)`,
    ).run(`ce2_${id}`, id, `https://github.com/acme/widget/pull/1290#discussion_r7`, 'please split this', NOW);
  }

  db.prepare(
    `INSERT OR REPLACE INTO mine_run
       (id, repo_id, started_at, finished_at, high_water_pr, observations, candidates)
     VALUES ('mr_smoke', 'r_smoke', ?, ?, 1290, 41, 6)`,
  ).run(NOW - 60_000, NOW - 30_000);

  // §M.2.4 — the pack behind the lane's latest turn, citing the active convention.
  db.prepare(
    `INSERT OR REPLACE INTO context_pack
       (id, task_id, chat_turn_id, arm, backend, retrieval_ms, assembly_ms, tokens_used, overflow,
        degraded, items_json, created_at)
     VALUES ('cp_smoke01', 't_smoke01', NULL, NULL, 'fts5', 3.4, 0.6, 212, 0, 0, ?, ?)`,
  ).run(
    JSON.stringify([
      { id: 'conventions:convention:cv_smoke01', ns: 'conventions', score: 0.92, src_table: 'convention', src_id: 'cv_smoke01' },
    ]),
    NOW,
  );

  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// §M.8.3 — a real policy file, loaded the way the daemon loads it, so the reload at boot finds
// the same hash and leaves it alone. One clause holds the approve button; one is only shown.
const policyDir = join(home, 'policies');
mkdirSync(policyDir, { recursive: true });
writeFileSync(
  join(policyDir, 'security.md'),
  [
    '---',
    'title: Security',
    '---',
    '',
    '## SEC-3.2 Retries must be bounded',
    'requires_ack: true',
    '',
    'Any retry loop must have a fixed upper bound and back off between attempts.',
    '',
    '## SEC-1.1 No secrets in tests',
    '',
    'Test fixtures must not contain real credentials or API keys.',
    '',
  ].join('\n'),
);
reloadPolicies(db, { env: { ...process.env, OSADE_HOME: home } });

// Bound to the gate the way `GateClauses.record` binds it: copied from the clause (M18).
db.prepare(
  `INSERT OR REPLACE INTO gate_clause
     (gate_id, hunk_ref, clause_id, clause_ref, title, text, scope, policy_path, file_sha,
      requires_ack, score)
   SELECT 'g_smoke01', 'src/poller.test.ts:42', pc.id, pc.clause_ref, pc.title, pc.text, p.scope,
          p.path, p.file_sha, pc.requires_ack, CASE pc.requires_ack WHEN 1 THEN 0.81 ELSE 0.44 END
     FROM policy_clause pc JOIN policy p ON p.id = pc.policy_id
    WHERE p.scope = 'global'`,
).run();

process.stdout.write(`seeded ${join(home, 'osade.db')} with t_smoke01\n`);
