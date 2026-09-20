/**
 * One resolver for where a lane's git cwd is.
 *
 * Attached lanes have `worktree_path = NULL` and run in the repository itself.
 * Isolated lanes have a worktree under `~/.osade/worktrees`. Every caller that used to
 * read `task.worktree_path` as a path must come through here — verification, diff,
 * checkpoints, launch, SCM writes.
 */

export function isAttached(task: { worktree_path: string | null }): boolean {
  return task.worktree_path == null;
}

export function taskCwd(task: { worktree_path: string | null }, repoPath: string): string {
  return task.worktree_path ?? repoPath;
}
