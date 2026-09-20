const PALETTE = ['claude', 'codex', 'opencode', 'pi'] as const;

export function agentColor(agentId: string | null | undefined): string {
  const id = agentId && agentId.length > 0 ? agentId : 'claude';
  if ((PALETTE as readonly string[]).includes(id)) return `var(--ag-${id})`;
  const pick = PALETTE[hash(id) % PALETTE.length]!;
  return `var(--ag-${pick})`;
}

function hash(value: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i++) n = (n * 31 + value.charCodeAt(i)) >>> 0;
  return n;
}
