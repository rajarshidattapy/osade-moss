import { describe, expect, it } from 'vitest';

import { ciVerifySteps, describeGates, parseWorkflow } from '../../src/domain/ci-workflows.js';

function workflow(yaml: string, path = '.github/workflows/ci.yml') {
  const parsed = parseWorkflow(yaml, path);
  if (!parsed) throw new Error('expected the workflow to parse');
  return parsed;
}

const CI = `
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  test:
    name: Unit tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - name: typecheck
        run: pnpm run typecheck
      - name: test
        run: pnpm run test
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run lint
`;

describe('parsing workflow YAML', () => {
  it('reads triggers, jobs and steps', () => {
    const w = workflow(CI);
    expect(w.name).toBe('CI');
    expect(w.triggers).toEqual(['pull_request', 'push']);
    expect(w.gatesPullRequests).toBe(true);
    expect(w.jobs.map((j) => j.id)).toEqual(['test', 'lint']);
    expect(w.jobs[0]?.steps).toHaveLength(5);
  });

  it('handles the YAML 1.1 trap where `on:` parses as the boolean true', () => {
    // The whole reason to use a parser rather than a regex, and the thing hand-rolled readers
    // get wrong: `on` is a boolean key in YAML 1.1.
    const w = workflow('on: [pull_request]\njobs: {}\n');
    expect(w.triggers).toEqual(['pull_request']);
    expect(w.gatesPullRequests).toBe(true);
  });

  it('accepts a string trigger', () => {
    expect(workflow('on: pull_request\njobs: {}\n').gatesPullRequests).toBe(true);
  });

  it('returns null for malformed YAML rather than throwing', () => {
    expect(parseWorkflow('name: [unclosed\n', 'x.yml')).toBeNull();
  });

  it('survives a workflow with no jobs at all', () => {
    const w = workflow('name: stub\n');
    expect(w.jobs).toEqual([]);
    expect(w.gatesPullRequests).toBe(false);
  });
});

describe('§13.2 — what CI runs on a pull request is what gates a contribution', () => {
  it('turns run steps into verify steps, citing the workflow and job', () => {
    const { steps } = ciVerifySteps([workflow(CI)]);

    expect(steps.map((s) => s.cmd)).toEqual([
      'pnpm run typecheck',
      'pnpm run test',
      'pnpm run lint',
    ]);
    expect(steps.every((s) => s.source === 'ci')).toBe(true);
    expect(steps.every((s) => s.required)).toBe(true);
    expect(steps[0]?.evidence).toBe('.github/workflows/ci.yml → test');
    expect(steps[0]?.name).toBe('typecheck');
  });

  it('ignores workflows a pull request does not trigger', () => {
    const nightly = workflow(
      'name: nightly\non:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  x:\n    steps:\n      - run: ./slow.sh\n',
      '.github/workflows/nightly.yml',
    );
    expect(ciVerifySteps([nightly]).steps).toEqual([]);
  });

  it('skips setup commands — installing dependencies is not a check', () => {
    const { steps } = ciVerifySteps([workflow(CI)]);
    expect(steps.some((s) => s.cmd.includes('install'))).toBe(false);
  });

  it('skips steps that depend on runner context, and says so', () => {
    const w = workflow(
      'on: [pull_request]\njobs:\n  x:\n    steps:\n      - run: pnpm test --shard ${{ matrix.shard }}\n',
    );
    const { steps, skipped } = ciVerifySteps([w]);

    expect(steps).toEqual([]);
    expect(skipped[0]?.reason).toBe('depends on runner context');
    expect(skipped[0]?.where).toBe('.github/workflows/ci.yml → x');
  });

  it('skips multi-line scripts rather than running a fragment of one', () => {
    const w = workflow(
      'on: [pull_request]\njobs:\n  x:\n    steps:\n      - run: |\n          set -e\n          ./configure\n          make check\n',
    );
    const { steps, skipped } = ciVerifySteps([w]);

    expect(steps).toEqual([]);
    expect(skipped).toEqual([
      { cmd: 'set -e', reason: 'multi-line script', where: '.github/workflows/ci.yml → x' },
    ]);
  });

  it('does not run the same command twice because two workflows share it', () => {
    const a = workflow('on: [pull_request]\njobs:\n  x:\n    steps:\n      - run: make test\n');
    const b = workflow(
      'on: [pull_request]\njobs:\n  y:\n    steps:\n      - run: make test\n',
      '.github/workflows/other.yml',
    );
    expect(ciVerifySteps([a, b]).steps).toHaveLength(1);
  });

  it('describes the gates for the miner and the UI', () => {
    expect(describeGates([workflow(CI)])).toEqual(['CI: Unit tests', 'CI: lint']);
  });
});
