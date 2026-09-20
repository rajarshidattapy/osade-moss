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

export type EventData =
  | {
      type: 'workspace_created';
      workspace: WorkspaceInfo;
    }
  | {
      type: 'workspace_updated';
      workspace: WorkspaceInfo;
    }
  | {
      type: 'workspace_metadata_updated';
      workspace: WorkspaceInfo;
    }
  | {
      type: 'workspace_closed';
      workspace?: WorkspaceInfo | null;
      workspace_id: string;
    }
  | {
      label: string;
      type: 'workspace_renamed';
      workspace_id: string;
    }
  | {
      insert_index: number;
      type: 'workspace_moved';
      workspace_id: string;
      workspaces: WorkspaceInfo[];
    }
  | {
      before_workspace_id?: string | null;
      type: 'workspace_reordered';
      workspace_ids: string[];
      workspaces: WorkspaceInfo[];
    }
  | {
      type: 'workspace_focused';
      workspace_id: string;
    }
  | {
      type: 'worktree_created';
      workspace: WorkspaceInfo;
      worktree: WorktreeInfo;
    }
  | {
      already_open: boolean;
      type: 'worktree_opened';
      workspace: WorkspaceInfo;
      worktree: WorktreeInfo;
    }
  | {
      forced: boolean;
      type: 'worktree_removed';
      workspace?: WorkspaceInfo | null;
      workspace_id: string;
      worktree: WorktreeInfo;
    }
  | {
      tab: TabInfo;
      type: 'tab_created';
    }
  | {
      tab_id: string;
      type: 'tab_closed';
      workspace_id: string;
    }
  | {
      label: string;
      tab_id: string;
      type: 'tab_renamed';
      workspace_id: string;
    }
  | {
      insert_index: number;
      tab_id: string;
      tabs: TabInfo[];
      type: 'tab_moved';
      workspace_id: string;
    }
  | {
      tab_id: string;
      type: 'tab_focused';
      workspace_id: string;
    }
  | {
      pane: PaneInfo;
      type: 'pane_created';
    }
  | {
      pane_id: string;
      type: 'pane_closed';
      workspace_id: string;
    }
  | {
      pane: PaneInfo;
      type: 'pane_updated';
    }
  | {
      pane_id: string;
      type: 'pane_focused';
      workspace_id: string;
    }
  | {
      closed_tab_id?: string | null;
      closed_workspace_id?: string | null;
      created_tab?: TabInfo | null;
      created_workspace?: WorkspaceInfo | null;
      pane: PaneInfo;
      previous_pane_id: string;
      previous_tab_id: string;
      previous_workspace_id: string;
      type: 'pane_moved';
    }
  | {
      pane_id: string;
      revision: number;
      type: 'pane_output_changed';
      workspace_id: string;
    }
  | {
      pane_id: string;
      type: 'pane_exited';
      workspace_id: string;
    }
  | {
      agent?: string | null;
      final_status?: AgentStatus | null;
      pane_id: string;
      released?: boolean;
      type: 'pane_agent_detected';
      workspace_id: string;
    }
  | {
      agent?: string | null;
      agent_status: AgentStatus;
      display_agent?: string | null;
      pane_id: string;
      state_labels?: {
        [k: string]: string;
      };
      title?: string | null;
      type: 'pane_agent_status_changed';
      workspace_id: string;
    }
  | {
      layout: PaneLayoutSnapshot;
      type: 'layout_updated';
    };
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type AgentSessionRefKind = 'id' | 'path';
export type SplitDirection = 'right' | 'down';
export type EventKind =
  | 'workspace_created'
  | 'workspace_updated'
  | 'workspace_metadata_updated'
  | 'workspace_closed'
  | 'workspace_renamed'
  | 'workspace_moved'
  | 'workspace_reordered'
  | 'workspace_focused'
  | 'worktree_created'
  | 'worktree_opened'
  | 'worktree_removed'
  | 'tab_created'
  | 'tab_closed'
  | 'tab_renamed'
  | 'tab_moved'
  | 'tab_focused'
  | 'pane_created'
  | 'pane_closed'
  | 'pane_updated'
  | 'pane_focused'
  | 'pane_moved'
  | 'pane_output_changed'
  | 'pane_exited'
  | 'pane_agent_detected'
  | 'pane_agent_status_changed'
  | 'layout_updated';

export interface Event {
  data: EventData;
  event: EventKind;
}
export interface WorkspaceInfo {
  active_tab_id: string;
  agent_status: AgentStatus;
  focused: boolean;
  label: string;
  number: number;
  pane_count: number;
  tab_count: number;
  tokens?: {
    [k: string]: string;
  };
  workspace_id: string;
  worktree?: WorkspaceWorktreeInfo | null;
}
export interface WorkspaceWorktreeInfo {
  checkout_path: string;
  is_linked_worktree: boolean;
  repo_key: string;
  repo_name: string;
  repo_root: string;
}
export interface WorktreeInfo {
  branch?: string | null;
  is_bare: boolean;
  is_detached: boolean;
  is_linked_worktree: boolean;
  is_prunable: boolean;
  label: string;
  open_workspace_id?: string | null;
  path: string;
}
export interface TabInfo {
  agent_status: AgentStatus;
  focused: boolean;
  label: string;
  number: number;
  pane_count: number;
  tab_id: string;
  workspace_id: string;
}
export interface PaneInfo {
  agent?: string | null;
  agent_session?: AgentSessionInfo | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  display_agent?: string | null;
  focused: boolean;
  foreground_cwd?: string | null;
  label?: string | null;
  pane_id: string;
  revision: number;
  scroll?: PaneScrollInfo | null;
  state_labels?: {
    [k: string]: string;
  };
  tab_id: string;
  terminal_id: string;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  title?: string | null;
  tokens?: {
    [k: string]: string;
  };
  workspace_id: string;
}
export interface AgentSessionInfo {
  agent: string;
  kind: AgentSessionRefKind;
  source: string;
  value: string;
}
export interface PaneScrollInfo {
  max_offset_from_bottom: number;
  offset_from_bottom: number;
  viewport_rows: number;
}
export interface PaneLayoutSnapshot {
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
  splits: PaneLayoutSplit[];
  tab_id: string;
  workspace_id: string;
  zoomed: boolean;
}
export interface PaneLayoutRect {
  height: number;
  width: number;
  x: number;
  y: number;
}
export interface PaneLayoutPane {
  focused: boolean;
  pane_id: string;
  rect: PaneLayoutRect;
}
export interface PaneLayoutSplit {
  direction: SplitDirection;
  id: string;
  ratio: number;
  rect: PaneLayoutRect;
}
