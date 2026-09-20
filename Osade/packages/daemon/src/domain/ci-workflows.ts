import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

import type { VerifyStep } from './verify-plan.js';

/**
 * Reading CI as evidence — OSADE.md §13.2.
 *
 * CI config is rated "mechanically enforced, so it is definitionally true", which makes it the
 * strongest input the miner has and the best source a verify plan can have. Until now Osade only
 * noted that CI *existed*; this reads what it actually runs.
 *
 * Two deliberate limits, both about honesty rather than effort:
 *
 *   - **Only pull-request-triggered workflows count.** A nightly job or a release pipeline is not
 *     what a contribution is judged against. What gates a PR is what runs on a PR.
 *   - **Unresolvable steps are skipped, not guessed.** A `run:` containing `${{ matrix.node }}`
 *     has no single meaning outside the runner, and inventing one produces a verify step that
 *     fails for reasons the agent cannot fix. They are reported instead, so the UI can say the
 *     plan is partial.
 */

export interface WorkflowStep {
  name: string | null;
  run: string | null;
  uses: string | null;
}

export interface WorkflowJob {
  id: string;
  name: string | null;
  steps: WorkflowStep[];
}

export interface Workflow {
  /** Repo-relative, so it can be cited. */
  path: string;
  name: string | null;
  /** The event names this workflow triggers on. */
  triggers: string[];
  jobs: WorkflowJob[];
  /** True when a `pull_request` event triggers it — the ones that gate a contribution. */
  gatesPullRequests: boolean;
}

/** Commands that set the machine up rather than check the work. Never a verify step. */
const SETUP_COMMANDS =
  /^(npm (ci|i|install)|pnpm (i|install)|yarn( install)?\b|bun install|corepack|nvm |apt-get|sudo |brew |pip install|poetry install|bundle install|go mod download|cargo fetch|rustup|git (config|fetch|clone)|echo |mkdir |cd )/;

/** Unresolvable outside the runner: expressions, env indirection, and secrets. */
const UNRESOLVABLE = /\$\{\{|\$GITHUB_|\$\{?RUNNER_/;

const DEFAULT_TIMEOUT_SEC = 600;

export async function readWorkflows(repoRoot: string): Promise<Workflow[]> {
  const dir = join(repoRoot, '.github', 'workflows');
  const entries = await readdir(dir).catch(() => [] as string[]);

  const workflows: Workflow[] = [];
  for (const file of entries) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = await readFile(join(dir, file), 'utf8').catch(() => null);
    if (text === null) continue;

    const parsed = parseWorkflow(text, `.github/workflows/${file}`);
    if (parsed) workflows.push(parsed);
  }
  return workflows;
}

/**
 * Parses one workflow document.
 *
 * Returns null rather than throwing on malformed YAML: one unparseable workflow in a repo is
 * common (a template, a half-finished branch) and must not take the whole plan down with it.
 */
export function parseWorkflow(text: string, path: string): Workflow | null {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;

  // `on:` is the YAML 1.1 boolean `true`, which is why so many tools get this wrong. The `yaml`
  // package parses to core schema so the key stays a string, but a document loaded elsewhere
  // may not have — both spellings are accepted.
  const triggers = readTriggers(doc.on ?? doc[true as unknown as string]);

  const jobsNode = doc.jobs;
  const jobs: WorkflowJob[] = [];
  if (isRecord(jobsNode)) {
    for (const [id, job] of Object.entries(jobsNode)) {
      if (!isRecord(job)) continue;
      jobs.push({
        id,
        name: typeof job.name === 'string' ? job.name : null,
        steps: readSteps(job.steps),
      });
    }
  }

  return {
    path,
    name: typeof doc.name === 'string' ? doc.name : null,
    triggers,
    jobs,
    gatesPullRequests: triggers.includes('pull_request') || triggers.includes('pull_request_target'),
  };
}

function readTriggers(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.filter((n): n is string => typeof n === 'string');
  if (isRecord(node)) return Object.keys(node);
  return [];
}

function readSteps(node: unknown): WorkflowStep[] {
  if (!Array.isArray(node)) return [];
  return node.filter(isRecord).map((step) => ({
    name: typeof step.name === 'string' ? step.name : null,
    run: typeof step.run === 'string' ? step.run : null,
    uses: typeof step.uses === 'string' ? step.uses : null,
  }));
}

export interface CiSteps {
  steps: VerifyStep[];
  /** Commands CI runs that Osade will not run locally, and why. Shown, not hidden. */
  skipped: { cmd: string; reason: string; where: string }[];
}

/**
 * Turns pull-request workflows into verify steps.
 *
 * These carry `source: 'ci'`, which is the strongest provenance §10.1 recognises — but the plan
 * still lands as `needsReview`. A command that passes on GitHub's runner can fail on a laptop
 * for a dozen environmental reasons, so CI tells us what the project checks, not that the check
 * will work here. The human confirms; nothing here changes that.
 */
export function ciVerifySteps(workflows: readonly Workflow[]): CiSteps {
  const steps: VerifyStep[] = [];
  const skipped: CiSteps['skipped'] = [];
  const seen = new Set<string>();

  for (const workflow of workflows) {
    if (!workflow.gatesPullRequests) continue;

    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const where = `${workflow.path} → ${job.id}`;
        if (step.run === null) continue;

        const cmd = step.run.trim();
        if (cmd.includes('\n')) {
          skipped.push({ cmd: firstLine(cmd), reason: 'multi-line script', where });
          continue;
        }
        if (UNRESOLVABLE.test(cmd)) {
          skipped.push({ cmd, reason: 'depends on runner context', where });
          continue;
        }
        if (SETUP_COMMANDS.test(cmd)) continue;
        if (seen.has(cmd)) continue;

        seen.add(cmd);
        steps.push({
          name: step.name ?? `${job.id}: ${cmd}`,
          cmd,
          cwd: '.',
          timeoutSec: DEFAULT_TIMEOUT_SEC,
          required: true,
          source: 'ci',
          evidence: where,
        });
      }
    }
  }

  return { steps, skipped };
}

/**
 * A one-line summary of what CI requires, for the miner's `ci_gates` extraction and for the UI.
 */
export function describeGates(workflows: readonly Workflow[]): string[] {
  return workflows
    .filter((w) => w.gatesPullRequests)
    .flatMap((w) => w.jobs.map((j) => `${w.name ?? w.path}: ${j.name ?? j.id}`));
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
