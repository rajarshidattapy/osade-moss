/** Subsequence or substring match on a repo-relative path. */
export function fuzzyPath(query: string, path: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const hay = path.toLowerCase();
  if (hay.includes(q)) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch !== q[i]) continue;
    i += 1;
    if (i === q.length) return true;
  }
  return false;
}
