/**
 * GENERATED — DO NOT EDIT.
 *
 * Source: vendor/runtime/0.8.2-p20/api-schema.json
 * Regenerate: pnpm substrate:codegen
 *
 * OSADE.md §4.1 — the pinned schema is the only codegen source. Never hand-write a substrate
 * method name, and never derive one from backend/.
 */

/* eslint-disable */

export type SubscriptionEventData =
  PaneOutputMatchedEvent | PaneAgentStatusChangedEvent | PaneScrollChangedEvent;
export type ReadFormat = 'text' | 'ansi';
export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type SubscriptionEventKind =
  'pane.output_matched' | 'pane.agent_status_changed' | 'pane.scroll_changed';

export interface SubscriptionEvent {
  data: SubscriptionEventData;
  event: SubscriptionEventKind;
}
export interface PaneOutputMatchedEvent {
  matched_line: string;
  pane_id: string;
  read: PaneReadResult;
}
export interface PaneReadResult {
  format: ReadFormat;
  pane_id: string;
  revision: number;
  source: ReadSource;
  tab_id: string;
  text: string;
  truncated: boolean;
  workspace_id: string;
}
export interface PaneAgentStatusChangedEvent {
  agent?: string | null;
  agent_status: AgentStatus;
  display_agent?: string | null;
  pane_id: string;
  state_labels?: {
    [k: string]: string;
  };
  title?: string | null;
  workspace_id: string;
}
export interface PaneScrollChangedEvent {
  pane_id: string;
  scroll: PaneScrollInfo;
  workspace_id: string;
}
export interface PaneScrollInfo {
  max_offset_from_bottom: number;
  offset_from_bottom: number;
  viewport_rows: number;
}
