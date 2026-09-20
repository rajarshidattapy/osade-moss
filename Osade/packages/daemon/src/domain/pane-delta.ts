/**
 * Pane-surface delta used as an agent reply when the agent does not report `final_message`.
 *
 * Capture at send, capture again at settle, store the difference after stripping the user's
 * echo and catalog chrome. Never scrape the pane as a live transcript.
 */

export function paneDelta(
  before: string,
  after: string,
  userText: string,
  strip: readonly string[] = [],
): string {
  let text = after;
  if (before.length > 0) {
    const overlap = overlapLength(before, after);
    if (overlap > 0) text = after.slice(overlap);
  }

  const echoed = userText.trim();
  if (echoed.length > 0) {
    const at = text.indexOf(echoed);
    if (at >= 0) text = text.slice(at + echoed.length);
  }

  const patterns = strip.map((source) => new RegExp(source, 'iu'));
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t.length === 0) return true;
      if (/^[❯›>]\s*$/u.test(t)) return false;
      return !patterns.some((pat) => pat.test(t));
    })
    .join('\n')
    .trim();
}

/**
 * How much of `after` is a suffix of `before` — the overlap of a sliding terminal window.
 *
 * Searching for the last 400 characters of `before` inside `after` is wrong: Claude and Codex
 * both end on the same prompt footer, so that needle matches the *end* of `after` and the
 * delta is empty even when the agent just replied.
 */
function overlapLength(before: string, after: string): number {
  if (after.startsWith(before)) return before.length;
  const max = Math.min(before.length, after.length);
  for (let n = max; n > 0; n--) {
    if (after.startsWith(before.slice(-n))) return n;
  }
  return 0;
}
