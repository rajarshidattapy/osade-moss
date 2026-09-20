export function heldReason(
  branch: string,
  holder: { title: string } | null | undefined,
): string | undefined {
  if (!holder) return undefined;
  return `${branch} is already checked out by “${holder.title}”`;
}

export function isolatedWorktreeHint(): string {
  return 'Each extra branch is its own git worktree. Close this lane and open one on the target branch.';
}

export function attachCheckoutHint(): string {
  return 'A new chat attaches to whatever is checked out. It does not switch you to main.';
}
