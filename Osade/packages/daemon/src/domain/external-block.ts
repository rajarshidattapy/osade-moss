/**
 * Session-limit / auth exits look like `done` to the substrate detector, which used to
 * produce `to_review`. They are not a finished turn.
 */

const QUOTA =
  /session limit|usage limit|rate limit|out of extra usage|hit your limit|you've hit your limit|limit reached/i;
const AUTH = /not logged in|please run \/login|authentication required|\bunauthorized\b|invalid api key|api.?key/i;
const RESET = /resets?\s+(.+?)(?:\.|$)/i;

export function classifyExternalBlock(text: string | null | undefined): string | null {
  if (!text) return null;
  if (QUOTA.test(text)) {
    const reset = text.match(RESET);
    return reset ? `Usage limit reached. Resets ${reset[1]!.trim()}.` : 'Usage limit reached.';
  }
  if (AUTH.test(text)) return 'The agent is not authenticated.';
  return null;
}
