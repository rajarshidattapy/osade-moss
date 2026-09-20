import { describe, expect, it } from 'vitest';

import { ScmClient, type ScmRequest } from '../../src/scm/client.js';
import { fetchCorpus } from '../../src/scm/corpus.js';

/**
 * §13.2 — building the mining corpus, against a recorded GitHub (§20.2).
 *
 * The behaviour under test is mostly about *budget*: what this fetches, what it refuses to
 * fetch, and what it keeps when it has to stop early.
 */

const NOW = 1_756_000_000_000;
const REPO = { id: 'r1', owner: 'acme', name: 'widget' };

interface Recorded {
  request: ScmRequest;
  calls: { route: string; params: Record<string, unknown> }[];
  setRemaining(n: number): void;
}

function recorded(
  handler: (route: string, params: Record<string, unknown>) => unknown,
  remaining = 4900,
): Recorded {
  const state = { remaining };
  const calls: { route: string; params: Record<string, unknown> }[] = [];

  const request: ScmRequest = async (route, params) => {
    calls.push({ route, params: params as Record<string, unknown> });
    const data = handler(route, params as Record<string, unknown>);
    if (data instanceof Error) throw data;
    return {
      status: 200,
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': String(state.remaining),
        'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 3600),
      },
      data,
    };
  };

  return { request, calls, setRemaining: (n) => (state.remaining = n) };
}

function pull(n: number, merged: boolean) {
  return {
    number: n,
    html_url: `https://github.com/acme/widget/pull/${n}`,
    title: `Change ${n}`,
    body: 'body',
    user: { login: 'contributor' },
    merged_at: merged ? '2025-08-01T00:00:00Z' : null,
    closed_at: '2025-08-02T00:00:00Z',
    updated_at: '2025-08-02T00:00:00Z',
  };
}

const REVIEW = [
  {
    html_url: 'https://github.com/acme/widget/pull/1#pullrequestreview-1',
    state: 'CHANGES_REQUESTED',
    body: 'Please split the refactor out.',
    submitted_at: '2025-08-01T12:00:00Z',
    user: { login: 'maintainer' },
  },
  {
    html_url: 'https://github.com/acme/widget/pull/1#pullrequestreview-2',
    state: 'APPROVED',
    body: null,
    submitted_at: '2025-08-01T13:00:00Z',
    user: { login: 'maintainer' },
  },
];

function client(rec: Recorded): ScmClient {
  return new ScmClient({ request: rec.request, now: () => NOW });
}

function defaultHandler(route: string, params: Record<string, unknown>): unknown {
  if (route === 'GET /repos/{owner}/{repo}/pulls') {
    return params.page === 1 ? [pull(20, false), pull(19, true), pull(18, true)] : [];
  }
  if (route.endsWith('/reviews')) return REVIEW;
  if (route.endsWith('/pulls/{pull_number}/comments')) return [];
  if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
    if (params.path === 'CONTRIBUTING.md') {
      return {
        content: Buffer.from('# Contributing\n\nOne concern per pull request.\n').toString('base64'),
        encoding: 'base64',
        html_url: 'https://github.com/acme/widget/blob/main/CONTRIBUTING.md',
        path: 'CONTRIBUTING.md',
      };
    }
    if (params.path === '.github/workflows') {
      return [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }];
    }
    if (params.path === '.github/workflows/ci.yml') {
      return {
        content: Buffer.from('on: [pull_request]\n').toString('base64'),
        encoding: 'base64',
        html_url: 'https://github.com/acme/widget/blob/main/.github/workflows/ci.yml',
      };
    }
    return Object.assign(new Error('Not Found'), { status: 404 });
  }
  return [];
}

describe('§13.2 — the corpus', () => {
  it('separates merged from closed-unmerged by merged_at, not by state', async () => {
    const rec = recorded(defaultHandler);
    const { corpus } = await fetchCorpus(client(rec), REPO);

    expect(corpus.pullRequests.find((p) => p.number === 20)?.outcome).toBe('closed_unmerged');
    expect(corpus.pullRequests.find((p) => p.number === 19)?.outcome).toBe('merged');
    expect(corpus.repoSlug).toBe('acme/widget');
  });

  it('fetches rejected pull requests before merged ones', async () => {
    const rec = recorded(defaultHandler);
    const { corpus } = await fetchCorpus(client(rec), REPO);
    expect(corpus.pullRequests[0]?.number).toBe(20);
  });

  it('drops a review that carries a verdict but no reason', async () => {
    const rec = recorded(defaultHandler);
    const { corpus } = await fetchCorpus(client(rec), REPO);

    const comments = corpus.pullRequests[0]?.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.state).toBe('changes_requested');
    expect(comments[0]?.body).toContain('split the refactor');
  });

  it('reads the stated rules and the workflows, decoding base64', async () => {
    const rec = recorded(defaultHandler);
    const { corpus } = await fetchCorpus(client(rec), REPO);

    const contributing = corpus.docs.find((d) => d.path === 'CONTRIBUTING.md');
    expect(contributing?.kind).toBe('doc');
    expect(contributing?.content).toContain('One concern per pull request.');

    const workflow = corpus.docs.find((d) => d.path === '.github/workflows/ci.yml');
    expect(workflow?.kind).toBe('ci_config');
    expect(workflow?.url).toContain('.github/workflows/ci.yml');
  });

  it('marks CODEOWNERS as its own kind — §13.4 lets one observation from it stand alone', async () => {
    const rec = recorded((route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls') return [];
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}' && params.path === 'CODEOWNERS') {
        return {
          content: Buffer.from('/src/db/ @dba\n').toString('base64'),
          encoding: 'base64',
          html_url: 'https://github.com/acme/widget/blob/main/CODEOWNERS',
        };
      }
      return Object.assign(new Error('Not Found'), { status: 404 });
    });

    const { corpus } = await fetchCorpus(client(rec), REPO);
    expect(corpus.docs.find((d) => d.path === 'CODEOWNERS')?.kind).toBe('codeowners');
  });

  it('treats a missing document as absent rather than as an error', async () => {
    const rec = recorded((route) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls') return [];
      return Object.assign(new Error('Not Found'), { status: 404 });
    });

    const warnings: string[] = [];
    const { corpus } = await fetchCorpus(client(rec), REPO, {
      onWarning: (m) => warnings.push(m),
    });

    expect(corpus.docs).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('§13.2 — capped by rate limit budget', () => {
  it('stops early and says so rather than starving the PR poller', async () => {
    const rec = recorded(defaultHandler, 100); // 2% remaining, below the §11.1 floor
    const warnings: string[] = [];

    const { corpus, partial } = await fetchCorpus(client(rec), REPO, {
      onWarning: (m) => warnings.push(m),
    });

    expect(partial).toBe(true);
    expect(warnings.some((w) => w.includes('rate limit'))).toBe(true);
    expect(corpus.pullRequests).toEqual([]);
  });

  it('honours the sample caps', async () => {
    const rec = recorded((route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls') {
        return params.page === 1
          ? [pull(30, true), pull(29, true), pull(28, false), pull(27, false)]
          : [];
      }
      return defaultHandler(route, params);
    });

    const { corpus } = await fetchCorpus(client(rec), REPO, {
      mergedSample: 1,
      rejectedSample: 1,
    });

    expect(corpus.pullRequests.map((p) => p.number).sort()).toEqual([28, 30]);
  });
});

describe('§13.4 — incremental re-mine', () => {
  it('skips pull requests the last run already saw', async () => {
    const rec = recorded(defaultHandler);
    const { corpus } = await fetchCorpus(client(rec), REPO, { sinceNumber: 19 });

    expect(corpus.pullRequests.map((p) => p.number)).toEqual([20]);
  });

  it('does not stop at the first old pull request in an update-ordered listing', async () => {
    // GitHub lists by update time, so a comment on an ancient PR puts it above newer ones.
    const rec = recorded((route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls') {
        return params.page === 1 ? [pull(2, true), pull(31, false), pull(30, true)] : [];
      }
      return defaultHandler(route, params);
    });

    const { corpus } = await fetchCorpus(client(rec), REPO, { sinceNumber: 19 });
    expect(corpus.pullRequests.map((p) => p.number).sort((a, b) => a - b)).toEqual([30, 31]);
  });
});
