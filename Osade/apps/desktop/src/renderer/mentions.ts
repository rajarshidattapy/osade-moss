export interface MentionTarget {
  agentId: string;
  text: string;
}

export interface ParsedMentions {
  shared: string;
  targets: MentionTarget[];
}

/** Mentions match only at the start of a line, against known catalog ids. */
export function parseMentions(raw: string, catalog: readonly string[]): ParsedMentions {
  const known = new Set(catalog);
  const shared: string[] = [];
  const byAgent = new Map<string, string[]>();
  let seenMention = false;

  for (const line of raw.split(/\r?\n/u)) {
    const match = /^@([a-z][a-z0-9_-]*)(?:\s+(.*))?$/iu.exec(line);
    const id = match?.[1]?.toLowerCase();
    if (id && known.has(id)) {
      seenMention = true;
      const body = (match?.[2] ?? '').trim();
      const list = byAgent.get(id) ?? [];
      if (body.length > 0) list.push(body);
      byAgent.set(id, list);
      continue;
    }
    if (!seenMention) shared.push(line);
    else {
      const last = [...byAgent.keys()].at(-1);
      if (last) {
        const list = byAgent.get(last) ?? [];
        list.push(line);
        byAgent.set(last, list);
      }
    }
  }

  return {
    shared: shared.join('\n').trim(),
    targets: [...byAgent.entries()].map(([agentId, lines]) => ({
      agentId,
      text: lines.join('\n').trim(),
    })),
  };
}

export function composeLanePrompt(shared: string, text: string): string {
  if (shared.length === 0) return text;
  if (text.length === 0) return shared;
  return `${shared}\n\n${text}`;
}

/** What actually gets sent to a lane. Empty `@claude` with no body must not become "". */
export function lanePrompt(parsed: ParsedMentions, target: MentionTarget, raw: string): string {
  const composed = composeLanePrompt(parsed.shared, target.text).trim();
  if (composed.length > 0) return composed;
  return raw.replace(/^@[a-z][a-z0-9_-]*\s*/iu, '').trim();
}
