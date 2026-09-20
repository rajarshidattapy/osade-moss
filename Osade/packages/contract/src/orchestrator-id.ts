/**
 * OSADE.md §17 — the synthetic home-lane id. Defined once; eslint forbids the raw literal elsewhere.
 */
const PREFIX = '__orchestrator__:';

export function orchestratorId(repoId: string): string {
  return `${PREFIX}${repoId}`;
}

export function isOrchestratorId(chatId: string): boolean {
  return chatId.startsWith(PREFIX);
}
