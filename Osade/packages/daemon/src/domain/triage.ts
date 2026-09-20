import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Db } from '../db/index.js';
import { getTask } from '../db/task-repo.js';
import type { ImportableIssue } from '../scm/poller.js';
import type { LaunchTask } from './launch-task.js';

/**
 * Issue intake and triage — OSADE.md §12.
 *
 * Importing an issue makes a task. But the higher-value path, and the one that earns
 * maintainer trust, is **triage that produces no PR at all**: a maintainer will accept a bot
 * that saves them 40 minutes of triage long before they accept a bot that adds a PR to their
 * queue. That is why this ships in M2 alongside the PR path rather than after it.
 *
 * Triage tasks terminate in an **artifact** — a reproduction log, a bisect result, a failing
 * test patch — rather than a pull request.
 */

export type TriageKind =
  | 'reproduce'
  | 'bisect'
  | 'failing-test'
  | 'duplicate-check'
  | 'verify-pr-claim';

export interface TriageArtifact {
  taskId: string;
  kind: TriageKind;
  /** What the agent concluded, in one line, for the issue comment. */
  verdict: string;
  /** The evidence, written to `~/.osade/runs/<task>/triage.md`. */
  path: string;
  producedAt: number;
}

/**
 * What each triage kind asks the agent to do.
 *
 * Every one of them ends with the same instruction: report, do not fix. A triage task that
 * quietly turns into a patch is a triage task that has become the thing §12 exists to avoid.
 */
const TRIAGE_BRIEF: Record<TriageKind, string> = {
  reproduce:
    'Reproduce the reported bug in this clean worktree. Report whether it reproduces, the ' +
    'exact steps you ran, and the output you saw. Do not fix anything.',
  bisect:
    'Find the commit that introduced this regression, using `git bisect` against the ' +
    'reproduction. Report the commit and how you confirmed it. Do not fix anything.',
  'failing-test':
    'Write the smallest test that demonstrates this bug and fails on the current code. ' +
    'Report the test and its output. Do not fix the bug itself.',
  'duplicate-check':
    'Determine whether this issue duplicates an existing one. Report the candidates you ' +
    'considered and why you did or did not conclude it is a duplicate. Do not fix anything, ' +
    'and do not close or comment on any issue.',
  'verify-pr-claim':
    "Check whether the pull request does what its description claims. Report what you " +
    'verified, what you could not verify, and anything the description omits. Do not change ' +
    'the pull request.',
};

export interface TriageOptions {
  now?: () => number;
  onWarning?: (message: string) => void;
}

export class Triage {
  readonly #db: Db;
  readonly #launcher: LaunchTask;
  readonly #now: () => number;

  constructor(db: Db, launcher: LaunchTask, options: TriageOptions = {}) {
    this.#db = db;
    this.#launcher = launcher;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Imports an issue as a task — §12.
   *
   * `origin_kind` records where the work came from, and `origin_ref` keeps the issue URL so a
   * comment can be posted back to the right place later (behind a gate, §11.2).
   */
  async importIssue(
    repoPath: string,
    issue: ImportableIssue,
    options: { triage?: TriageKind } = {},
  ): Promise<string> {
    const intent = options.triage
      ? [
          `Issue #${issue.number}: ${issue.title}`,
          '',
          issue.body.trim() || '(no description)',
          '',
          '---',
          TRIAGE_BRIEF[options.triage],
        ].join('\n')
      : [
          `Issue #${issue.number}: ${issue.title}`,
          '',
          issue.body.trim() || '(no description)',
        ].join('\n');

    const created = await this.#launcher.createTask({
      repoPath,
      title: `#${issue.number} ${issue.title}`,
      intent,
      isolate: true,
    });
    const taskId = created.taskId;

    this.#db
      .prepare('UPDATE task SET origin_kind = ?, origin_ref = ? WHERE id = ?')
      .run(options.triage ? 'triage' : 'issue', issue.url, taskId);

    if (options.triage) {
      this.#db
        .prepare(
          "INSERT OR REPLACE INTO task_lane (task_id, lane, value) VALUES (?, 'triage_kind', ?)",
        )
        .run(taskId, options.triage);
    }

    return taskId;
  }

  isTriage(taskId: string): boolean {
    return getTask(this.#db, taskId)?.origin_kind === 'triage';
  }

  triageKind(taskId: string): TriageKind | null {
    const row = this.#db
      .prepare("SELECT value FROM task_lane WHERE task_id = ? AND lane = 'triage_kind'")
      .get(taskId) as { value: string } | undefined;
    return (row?.value as TriageKind) ?? null;
  }

  /**
   * Records the artifact a triage task terminates in — §12.
   *
   * Written to disk under `~/.osade/runs/` rather than kept in the database: the evidence is
   * what a maintainer reads, and it should survive `osade.db` being deleted.
   */
  async recordArtifact(
    taskId: string,
    kind: TriageKind,
    verdict: string,
    evidence: string,
    runsDir: string,
  ): Promise<TriageArtifact> {
    const dir = join(runsDir, taskId);
    const path = join(dir, 'triage.md');
    await mkdir(dir, { recursive: true });

    const task = getTask(this.#db, taskId);
    await writeFile(
      path,
      [
        `# Triage: ${kind}`,
        '',
        `**Verdict:** ${verdict}`,
        '',
        task?.origin_ref ? `Issue: ${task.origin_ref}` : '',
        task ? `Base: \`${task.base_sha}\` on \`${task.base_ref}\`` : '',
        '',
        '## Evidence',
        '',
        evidence,
        '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
      'utf8',
    );

    const artifact: TriageArtifact = {
      taskId,
      kind,
      verdict,
      path,
      producedAt: this.#now(),
    };

    // Reuse `turn_checkpoint`'s sibling table rather than adding one: the artifact is a lane
    // output, and M3's conventions work will want the same shape.
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO task_lane (task_id, lane, value) VALUES (?, 'triage_artifact', ?)",
      )
      .run(taskId, JSON.stringify(artifact));

    return artifact;
  }

  artifactFor(taskId: string): TriageArtifact | null {
    const row = this.#db
      .prepare("SELECT value FROM task_lane WHERE task_id = ? AND lane = 'triage_artifact'")
      .get(taskId) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as TriageArtifact) : null;
  }

  /**
   * The comment a triage task offers to post — §11.2, gated like every public write.
   *
   * Disclosure is not optional. §23 open question 3 recommends always disclosing and making
   * the line non-editable; this composes it into the body so an edit-and-approve cannot
   * quietly remove it.
   */
  composeComment(artifact: TriageArtifact, evidence: string): string {
    return [
      artifact.verdict,
      '',
      evidence.trim(),
      '',
      '---',
      '_Produced by an agent through Osade, and reviewed by a human before posting._',
    ].join('\n');
  }
}

/** The brief for a kind, exposed so the UI can show what a triage task will actually do. */
export function triageBrief(kind: TriageKind): string {
  return TRIAGE_BRIEF[kind];
}

/** A stable id for an artifact file, when one is needed outside the task scope. */
export function artifactId(): string {
  return `a_${randomUUID().slice(0, 8)}`;
}
