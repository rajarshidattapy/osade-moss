---
name: osade
description: "Control Osade, a terminal multiplexer for coding agents. Use only when the user explicitly mentions Osade or asks to use Osade to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires OSADE_ENV=1."
---

# Osade

Osade organizes terminals into workspaces, tabs, and panes, recognizes coding agents running inside panes, and exposes the current session through the `osade` CLI.

Before issuing any control command, verify that this agent is running inside a Osade-managed pane:

```bash
test "${OSADE_ENV:-}" = 1
```

If the check fails, say that you are not running inside Osade and stop. Do not inspect or control the focused Osade session from outside Osade.

When the check passes, the `osade` binary in `PATH` talks to the current session. Use it to inspect neighboring work, create terminal layout, start agents and commands, read output, and wait for state changes.

## Learn the current CLI

The installed binary is the authority for command syntax. Start with:

```bash
osade --help
```

Then print the relevant command group by running the group without a subcommand:

```bash
osade agent
osade pane
osade workspace
osade tab
osade worktree
osade terminal
osade notification
osade integration
osade session
```

Do not run bare `osade` for discovery; it launches or attaches the TUI. Do not probe a mutating nested command by omitting arguments. Commands such as `osade workspace create` are valid with defaults and will execute.

Most control commands return JSON. Read identifiers and state from those responses instead of predicting them.

## Understand layout, panes, and agents

Choose the primitive that matches the job:

- Workspace, tab, and pane topology organize terminal locations.
- Pane commands control raw terminals, shells, tests, servers, input, and output.
- Agent commands control the recognized coding agent currently occupying a pane.

A pane exists whether or not it contains an agent. `agent start` requires an existing available shell pane and never creates, splits, or moves layout. Use pane commands for ordinary processes. Use agent commands when Osade must validate agent identity or interpret `idle`, `working`, `blocked`, `done`, and `unknown` lifecycle states.

Agent commands accept either a unique live agent name or the pane ID currently hosting that agent. They do not accept terminal IDs or bare agent-kind labels. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents. A name follows the current pane occupant and is cleared when that agent exits, is released, or is replaced.

`idle` means the agent is ready for input and its tab has been seen in the focused Osade UI. `done` is the same underlying idle state after unseen background work finishes. Focusing the tab or targeting the pane or agent with a focus command marks it seen. CLI reads do not mark it seen. `blocked` means Osade recognized an approval or question UI. `unknown` means an agent is present but Osade cannot classify it confidently; it does not prove completion.

## Use IDs and caller context

Public IDs are opaque stable handles:

- workspace: `w1`
- tab: `w1:t1`
- pane: `w1:p1`

Closed tab and pane IDs are not reused. A pane moved into another workspace receives a new workspace-qualified pane ID. After `pane move`, continue with `.result.move_result.pane.pane_id` or the live agent name. The old value is reported as `.result.move_result.previous_pane_id`; only the moved process's inherited caller context keeps resolving that old ID, so do not use it as a general agent target.

Osade injects the caller's context into each managed pane:

```bash
printf '%s\n' "$OSADE_WORKSPACE_ID" "$OSADE_TAB_ID" "$OSADE_PANE_ID"
```

Prefer `--current` when a pane command should target the calling pane. Omitting a target may use the UI-focused pane, which can belong to the user or another client.

Discover live state with:

```bash
osade workspace list
osade tab list --workspace "$OSADE_WORKSPACE_ID"
osade pane current --current
osade pane list --workspace "$OSADE_WORKSPACE_ID"
osade agent list
```

Creation responses expose the IDs to use next. `workspace create` returns `.result.workspace`, `.result.tab`, and `.result.root_pane`. `tab create` returns `.result.tab` and `.result.root_pane`. `pane split` returns the new pane as `.result.pane`.

## Start and coordinate an agent

Default to a sibling pane in the current tab and the current working directory. Do not create a workspace, tab, worktree, or different cwd unless the user explicitly requests that topology or location.

Honor a direction requested by the user. Otherwise inspect the caller pane:

```bash
osade pane layout --pane "$OSADE_PANE_ID"
```

Split a wide pane to the right and a narrow or tall pane down. Avoid repeated same-direction splits that create unusably narrow columns or short rows. Keep the user's focus in the calling pane and explicitly preserve the caller's working directory:

```bash
osade pane split --current --direction right --cwd "$PWD" --no-focus
```

Replace `right` with `down` when appropriate. Read the new pane ID from `.result.pane.pane_id`.

An available shell pane must be at its interactive prompt, with the shell itself in the foreground and no foreground command, editor, or agent running. Start a supported agent in that pane with a useful unique name:

```bash
osade agent start reviewer --kind codex --pane <returned-pane-id>
```

Use the kind requested by the user. Run `osade agent` to inspect the installed kind list and options. Pass native agent arguments only after `--`:

```bash
osade agent start reviewer --kind codex --pane <returned-pane-id> -- <agent-args...>
```

A successful `agent start` returns only after Osade detects the expected agent in the same pane and considers it ready for interactive input. If the agent is blocked during startup, the command returns `agent_not_ready` immediately but keeps the name available for `agent read` and `agent send-keys`. Wait until the agent becomes idle before prompting it. Startup defaults to a 30-second timeout.

Submit work through the agent surface:

```bash
osade agent prompt reviewer "Review the current diff and report only actionable findings." --wait --timeout 120000
```

`agent prompt` honors the pane's live bracketed-paste mode and sends text followed by encoded Enter after a short delay. It rejects an agent already waiting at an approval or question dialog with `agent_blocked` before sending any input. Inspect the blocked UI and ask the user before answering it. For normal agent work, `--wait` is enough: it waits for the first settled `idle`, `done`, or `blocked` state. Do not repeat those defaults with `--until`.

A prompt sent from a non-working state must produce an observed lifecycle change within five seconds. Otherwise Osade returns `agent_prompt_stalled` instead of waiting indefinitely. This wait tracks lifecycle state, not an individual turn; if the agent is already working, completion of the active turn may satisfy it.

Use `--until` only for a state-specific workflow, such as waiting for an already-running agent to request input:

```bash
osade agent wait reviewer --until blocked --timeout 120000
```

Without `--until`, standalone `agent wait` uses the same settled-state defaults as `agent prompt --wait`.

Use logical keys for interactive agent UI controls:

```bash
osade agent send-keys reviewer esc
osade agent send-keys reviewer ctrl+c
```

Osade validates all keys before writing any bytes. Read the result through the resolved agent:

```bash
osade agent get reviewer
osade agent read reviewer --source recent-unwrapped --lines 120
```

If a wait fails or returns `blocked`, inspect `agent get` and `agent read` before deciding what input to send. Use the pane surface only when raw terminal control is intentional.

## Run an ordinary command in another pane

Create a sibling pane with the same geometry rule, preserve the caller's working directory, and keep user focus unchanged:

```bash
osade pane split --current --direction right --cwd "$PWD" --no-focus
```

Read the new pane ID from `.result.pane.pane_id`, then run and inspect the command:

```bash
osade pane run <returned-pane-id> "just test"
osade pane wait-output <returned-pane-id> --match "test result" --timeout 120000
osade pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

`pane run` atomically sends command text and Enter. `pane wait-output` searches the selected snapshot immediately, so output that already exists can match. Use `--match <text>` for a literal substring or `--regex <pattern>` for a Rust regular expression. Omitting `--timeout` allows an indefinite wait.

Use the read source that matches the task:

- `visible`: the currently rendered viewport.
- `recent`: recent rendered output, including soft wraps.
- `recent-unwrapped`: recent output with soft wraps joined; prefer it for logs and transcripts.
- `detection`: the plain-text bottom-buffer snapshot used for agent detection.

Use `--format ansi` when colors and terminal styling are evidence. Otherwise use text.

`--lines` asks Osade for more rows from the pane's available screen and host scrollback. If increasing it does not reveal more of a completed response, the pane is probably running the agent on the terminal's alternate screen. Rows that leave the alternate screen do not enter Osade's host scrollback, so a larger line count cannot recover them.

After that failed read, ask the agent to write its complete response as Markdown in a temporary directory and reply only with the file path, then read the file directly. Use this only as a fallback; do not request file output in the initial prompt.

## Safety and coordination rules

- Use `--no-focus` for background work unless the user asked to switch context.
- Use `--current`, an explicit pane ID, or a unique agent name. Do not rely on another client's focused pane.
- Parse IDs from JSON responses. Do not derive them from sidebar order or examples.
- Do not close workspaces, tabs, panes, or sessions you did not create unless the user explicitly asked.
- Never run `osade server stop` from an active session unless the user explicitly intends to stop the server and its pane processes.
- Never kill the main Osade process. Use named test sessions for experiments that need an isolated server.
- CLI server errors are JSON on stderr with exit status 1. CLI syntax errors exit with status 2.
