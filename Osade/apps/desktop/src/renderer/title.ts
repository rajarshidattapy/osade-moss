const GREETINGS = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'sup',
  'thanks',
  'thank you',
  'ok',
  'okay',
  'yes',
  'yeah',
  'no',
  'hmm',
  'test',
]);

/** First-message titles. Short or greeting → "New chat"; a real sentence becomes the title. */
export function titleFrom(message: string): string {
  const stripped = message.trim().replace(/[.,!?;:]+$/u, '');
  const words = stripped.split(/\s+/u).filter(Boolean);
  if (words.length === 0) return 'New chat';
  const joined = words.slice(0, 8).join(' ');
  if (words.length < 4 || GREETINGS.has(stripped.toLowerCase())) return 'New chat';
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Branch slug follows the title; "New chat" falls back to the short task id. */
export function branchSlugFromTitle(title: string, taskId: string): string {
  if (title.trim().length === 0 || title === 'New chat') return taskId.replace(/^t_/, '');
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || taskId.replace(/^t_/, '')
  );
}
