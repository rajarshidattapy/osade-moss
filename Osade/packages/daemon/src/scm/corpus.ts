import type {
  Corpus,
  PullRequestRecord,
  RepoDocRecord,
  ReviewComment,
} from '../knowledge/types.js';

import { NOT_MODIFIED, ScmClient } from './client.js';

/**
 * Building the mining corpus from GitHub — OSADE.md §13.2.
 *
 * This is the only file that knows the miner's inputs come from GitHub. Everything under
 * `knowledge/` works on the neutral records in `knowledge/types.ts`, which is what lets the
 * pipeline be tested against fixtures instead of a recorded API.
 *
 * **The budget is the design constraint.** §13.2's default sample is 200 merged and 100
 * closed-unmerged pull requests, "capped by rate limit budget" — and each PR costs two extra
 * requests for its review threads. A naive fetch would exhaust an hour of quota on one repo and
 * leave the PR poller (§11.1) unable to answer whether a task's own PR is still open, which
 * matters far more than mining. So this stops early and returns what it has: a partial corpus is
 * a fine input to a pipeline whose output is candidate rules awaiting confirmation.
 */

export const DEFAULT_MERGED_SAMPLE = 200;
export const DEFAULT_REJECTED_SAMPLE = 100;

/** Documents worth reading, in the order GitHub projects actually put them. */
const DOC_PATHS = [
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
];

export interface FetchCorpusOptions {
  mergedSample?: number;
  rejectedSample?: number;
  /** §13.4 — incremental re-mine: only pull requests newer than this. */
  sinceNumber?: number | null;
  onWarning?: (message: string) => void;
}

export interface CorpusResult {
  corpus: Corpus;
  /** True when the fetch stopped early on rate limit. The run is still usable. */
  partial: boolean;
}

interface PullListItem {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

interface ReviewPayload {
  html_url: string;
  state: string;
  body: string | null;
  submitted_at: string | null;
  user: { login: string } | null;
}

interface ReviewCommentPayload {
  html_url: string;
  body: string;
  created_at: string;
  user: { login: string } | null;
}

interface ContentPayload {
  content?: string;
  encoding?: string;
  html_url?: string;
  path?: string;
}

export async function fetchCorpus(
  scm: ScmClient,
  repo: { id: string; owner: string; name: string },
  options: FetchCorpusOptions = {},
): Promise<CorpusResult> {
  const onWarning = options.onWarning ?? (() => {});
  const mergedCap = options.mergedSample ?? DEFAULT_MERGED_SAMPLE;
  const rejectedCap = options.rejectedSample ?? DEFAULT_REJECTED_SAMPLE;
  const since = options.sinceNumber ?? null;

  const merged: PullListItem[] = [];
  const rejected: PullListItem[] = [];
  let partial = false;

  // Closed PRs, newest first. `state=closed` covers both outcomes in one listing, which halves
  // the request count versus asking for each separately.
  for (let page = 1; page <= 10; page += 1) {
    if (scm.shouldBackOff) {
      partial = true;
      onWarning('stopped listing pull requests: GitHub rate limit budget is low');
      break;
    }

    const listing = await scm.get<PullListItem[]>('GET /repos/{owner}/{repo}/pulls', {
      owner: repo.owner,
      repo: repo.name,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      page,
    });
    if (listing === NOT_MODIFIED) break;
    if (listing.length === 0) break;

    let reachedHighWater = false;
    for (const item of listing) {
      // §13.4 — incremental. The listing is by update time, not number, so a stale PR can appear
      // among newer ones; skip it rather than stopping, or one touched old PR truncates the run.
      if (since !== null && item.number <= since) {
        reachedHighWater = true;
        continue;
      }
      if (item.merged_at) {
        if (merged.length < mergedCap) merged.push(item);
      } else if (rejected.length < rejectedCap) {
        rejected.push(item);
      }
    }

    if (merged.length >= mergedCap && rejected.length >= rejectedCap) break;
    // Every PR on this page was already mined; older pages will be too.
    if (reachedHighWater && listing.every((i) => since !== null && i.number <= since)) break;
  }

  const pullRequests: PullRequestRecord[] = [];
  // Rejections first: §13.2 rates them the strongest signal, so if the budget runs out mid-fetch
  // the corpus keeps the part that is worth the most.
  for (const item of [...rejected, ...merged]) {
    if (scm.shouldBackOff) {
      partial = true;
      onWarning(`stopped fetching review threads after PR #${item.number}: rate limit budget low`);
      break;
    }
    pullRequests.push(await fetchPullRequest(scm, repo, item, onWarning));
  }

  return {
    corpus: {
      repoId: repo.id,
      repoSlug: `${repo.owner}/${repo.name}`,
      pullRequests,
      docs: await fetchDocs(scm, repo, onWarning),
    },
    partial,
  };
}

/**
 * How many rounds of "changes requested" a pull request took — OSADE.md §13.6.
 *
 * This is the number the whole conventions feature exists to move, so it is counted from
 * GitHub's own record rather than inferred from anything Osade stored. Returns null when the
 * reviews cannot be read, which is different from zero and must stay different: a PR nobody
 * reviewed and a PR whose reviews we failed to fetch are not the same data point.
 */
export async function fetchReviewRounds(
  scm: ScmClient,
  repo: { owner: string; name: string },
  prNumber: number,
): Promise<number | null> {
  try {
    const reviews = await scm.get<ReviewPayload[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      { owner: repo.owner, repo: repo.name, pull_number: prNumber, per_page: 100 },
    );
    if (reviews === NOT_MODIFIED) return null;
    return reviews.filter((r) => r.state.toUpperCase() === 'CHANGES_REQUESTED').length;
  } catch {
    return null;
  }
}

async function fetchPullRequest(
  scm: ScmClient,
  repo: { owner: string; name: string },
  item: PullListItem,
  onWarning: (message: string) => void,
): Promise<PullRequestRecord> {
  const comments: ReviewComment[] = [];

  try {
    const reviews = await scm.get<ReviewPayload[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      { owner: repo.owner, repo: repo.name, pull_number: item.number, per_page: 50 },
    );
    if (reviews !== NOT_MODIFIED) {
      for (const review of reviews) {
        // A review with no body is a verdict without a reason; it cannot support a rule.
        if (!review.body) continue;
        comments.push({
          url: review.html_url,
          author: review.user?.login ?? null,
          body: review.body,
          state: reviewState(review.state),
          at: toMs(review.submitted_at) ?? toMs(item.closed_at) ?? 0,
        });
      }
    }
  } catch (error) {
    onWarning(`could not read reviews for PR #${item.number}: ${(error as Error).message}`);
  }

  try {
    const inline = await scm.get<ReviewCommentPayload[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      { owner: repo.owner, repo: repo.name, pull_number: item.number, per_page: 50 },
    );
    if (inline !== NOT_MODIFIED) {
      for (const comment of inline) {
        comments.push({
          url: comment.html_url,
          author: comment.user?.login ?? null,
          body: comment.body,
          // An inline comment carries no verdict of its own; the review above holds that.
          state: 'commented',
          at: toMs(comment.created_at) ?? 0,
        });
      }
    }
  } catch (error) {
    onWarning(`could not read comments for PR #${item.number}: ${(error as Error).message}`);
  }

  return {
    number: item.number,
    url: item.html_url,
    title: item.title,
    body: item.body,
    outcome: item.merged_at ? 'merged' : 'closed_unmerged',
    author: item.user?.login ?? null,
    closedAt: toMs(item.merged_at) ?? toMs(item.closed_at) ?? 0,
    comments,
  };
}

async function fetchDocs(
  scm: ScmClient,
  repo: { owner: string; name: string },
  onWarning: (message: string) => void,
): Promise<RepoDocRecord[]> {
  const docs: RepoDocRecord[] = [];

  for (const path of DOC_PATHS) {
    if (scm.shouldBackOff) break;
    const doc = await fetchOneDoc(scm, repo, path, /codeowners/i.test(path) ? 'codeowners' : 'doc');
    if (doc) docs.push(doc);
  }

  // Workflow files. §13.2 rates CI the strongest evidence there is, so these are worth the
  // extra listing request even when the doc fetches came back empty.
  try {
    const listing = await scm.get<{ name: string; path: string }[]>(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner: repo.owner, repo: repo.name, path: '.github/workflows' },
    );
    if (listing !== NOT_MODIFIED && Array.isArray(listing)) {
      for (const entry of listing) {
        if (!/\.ya?ml$/.test(entry.name)) continue;
        if (scm.shouldBackOff) break;
        const doc = await fetchOneDoc(scm, repo, entry.path, 'ci_config');
        if (doc) docs.push(doc);
      }
    }
  } catch (error) {
    // A repo with no workflows 404s here, which is not worth a warning.
    if ((error as { status?: number }).status !== 404) {
      onWarning(`could not list workflows: ${(error as Error).message}`);
    }
  }

  return docs;
}

async function fetchOneDoc(
  scm: ScmClient,
  repo: { owner: string; name: string },
  path: string,
  kind: RepoDocRecord['kind'],
): Promise<RepoDocRecord | null> {
  try {
    const payload = await scm.get<ContentPayload>('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.name,
      path,
    });
    if (payload === NOT_MODIFIED || !payload.content) return null;

    const content =
      payload.encoding === 'base64'
        ? Buffer.from(payload.content, 'base64').toString('utf8')
        : payload.content;

    return {
      kind,
      path,
      url: payload.html_url ?? `https://github.com/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
      content,
    };
  } catch {
    // Absent is the common case for every path in the list. Not an error.
    return null;
  }
}

function reviewState(state: string): ReviewComment['state'] {
  switch (state.toUpperCase()) {
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'APPROVED':
      return 'approved';
    case 'DISMISSED':
      return 'dismissed';
    default:
      return 'commented';
  }
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
