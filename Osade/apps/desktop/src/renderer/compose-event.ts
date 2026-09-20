export const COMPOSE_EVENT = 'osade:compose';

export function composeAppend(text: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: text }));
}
