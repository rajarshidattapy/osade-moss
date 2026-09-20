# Osade

**Your team and its coding agents, one live workspace.**

Bring your own agent · Human-approved, always

---

Osade is a desktop workspace where you and your teammates run coding agents on real repositories
together. Open a repo and type into a chat, and an agent starts working. Mention a second agent and
it gets its own branch next to the first. A teammate can join the session, see what happened while
they were gone, redirect an agent, or approve its next move.

Nothing ships until it's verified and a named human signs off. Osade never merges.

It doesn't ship a model. It drives the agent CLIs you already pay for: `claude`, `codex`, `opencode`, `pi`.

## What you can do with it

**Talk to an agent instead of configuring a task.** A new chat is an empty box. Type, and the agent
starts. Branch names and titles come from what you wrote.

**Run several agents in one conversation.** Put `@claude` and `@codex` on separate lines and you get
two agents, each on its own branch, sharing one transcript and learning from each other's verified
work.

**Stay on your real checkout.** The first chat attaches to your working tree on whatever branch is
checked out, so there's no surprise branch. Extra chats and agents get isolated worktrees
automatically, so two agents never write to the same tree.

**Review without leaving the window.** Files, Checks, Diff and Rules sit next to the chat. The
composer attaches whatever you're looking at, so you can ask "why did you change this" while
reading a hunk.

**Approve anything that leaves the machine.** Commits, pushes, PRs and comments are gated. Approval
binds to the exact payload, and a change after approval voids it.

## New: Osade × Moss 🚧

These features are being built for the **YC Fall 2026 × Moss Zero Latency Builder Sprint**, with
[Moss](https://moss.dev) as the shared-context layer.

| | Feature | What it does |
| --- | --- | --- |
| 🔁 | **Self-maintaining APIs** | An SDK ships a breaking change. Osade finds every affected call site across your repos, including wrappers and aliased imports that grep misses, and runs one agent lane per repo to a verified PR. |
| 👥 | **Multiplayer lanes** | Teammates join a live session under their GitHub identity, catch up from cited history in milliseconds, and approve gates as themselves. |
| ✍️ | **Human-approved PRs** | Every PR carries a signed record of which human approved which exact commit after which checks passed. Maintainers get near-duplicate PR detection. |
| 📋 | **Compliance on the gate** | The policy clauses a diff touches show up on the approval card, bind into the approval, and export as audit evidence. |

**Where Moss fits:** every agent turn is assembled from filtered, budgeted, cited retrievals
(conventions, sibling agents' verified fixes, chat history), targeting p95 under 30 ms. Retrieval
sits on the critical path of every turn across every lane, which is why speed matters here. Moss
is a derived, rebuildable index; SQLite stays the only source of truth.

**Built so far:** the retrieval layer (one writer, a `retrieval_log` the database triggers
maintain, `osade index rebuild` as the defined recovery); per-turn context assembly with a cited
block on every prompt; **self-maintaining APIs end to end** — changelog extraction gated on human
confirmation, tree-sitter chunking with resolved-context enrichment, retrieval-vs-grep discovery,
waves gated on a green canary, and lanes that publish their verified fixes to their siblings
(`osade migrate`); and **compliance on the gate** — policy clauses matched to the hunks they
cover, bound into the approval hash, with `requires_ack` clauses blocking approval until a named
human acknowledges them (`osade policy`). Multiplayer lanes and human-approval attestation are
still to come.

## Quickstart

You need **Node.js 22+**, **pnpm** (`corepack enable`), **git**, and at least one agent CLI on your
`PATH`.

```bash
git clone https://github.com/OsadeOSS/Osade.git
cd Osade
pnpm install
node scripts/fetch-substrate-binaries.mjs
pnpm --filter @osade/desktop start
```

The window opens. Open a folder, type something, press Enter.

To put `osade` on your PATH (Windows and POSIX):

```bash
node scripts/install-cli.mjs
```

Then `osade .` in any repo opens the window on it, the way `code .` does.

Osade runs on macOS, Linux and Windows. Everything it writes lives in `~/.osade`
(`%USERPROFILE%\.osade` on Windows); delete that folder to reset completely.

Optional:

- Set `OSADE_GITHUB_TOKEN` and Osade uses it for issues and PRs. Without it, GitHub features stay
  off. (🚧 Picking up an existing `gh auth login` session is planned, not wired up.)
- Set `MOSS_PROJECT_ID` / `MOSS_PROJECT_KEY` to run retrieval on Moss. Without them Osade falls
  back to SQLite FTS5 and says so — `osade index stats` prints which backend is live, its doc
  counts and its p50/p95.

<details>
<summary>Windows desktop shortcut</summary>

After a successful start (so `apps/desktop/dist` exists):

```powershell
powershell -File scripts/install-desktop-shortcut.ps1
```

This launches the checkout, not a packaged installer.

</details>

## How it works

Three processes. The daemon and the substrate keep running when you close the window, so agents
don't die with the app.

```text
Electron app        chats, lanes, files, diffs, checks, gates
      │  tRPC + WebSocket over loopback (127.0.0.1)
Osade daemon        lanes, verification, gates, GitHub, conventions, Moss retrieval
      │             SQLite facts + change_log → CDC to every connected client
      │  JSON API over a local socket
terminal substrate  PTYs, worktrees, agent detection, session persistence
```

Osade doesn't reimplement terminals. A headless substrate owns PTYs, git worktrees and agent
detection, and Osade drives it over a JSON API.

Three invariants are worth knowing before you read the code:

- **No `status` column.** Task status is a pure function over durable facts, recomputed on every
  read. A flaky probe can't kill a live agent.
- **One event path.** Every change reaches every client through a SQLite trigger into `change_log`.
  If the UI didn't update, the write didn't go through the database.
- **Nothing public without a gate.** Every push, PR and comment is a hashed approval request first,
  re-checked at execution.

## Why it works this way

Open source is pushing back on autonomous AI contributions: maintainers are drowning in agent PRs
that don't meet their bar. The bottleneck is review capacity, not code production, so a tool that
produces *more* agent PRs makes things worse.

Osade optimizes for the opposite: **make an agent-assisted PR cheaper to review than a human one.**
That's why verification, evidence-cited conventions and human gates are the core of the product
rather than add-ons. It's also why the most valuable thing an agent can do is often triage that
produces no PR at all: reproduce a bug, bisect a regression, write a failing test.

The long version is in [docs/osade/OSADE.md](docs/osade/OSADE.md).

## Status

Early and moving fast. Usable, not stable. The Moss features are under active development.

## Docs

| | |
| --- | --- |
| [docs/osade/architechture.md](docs/osade/architechture.md) | How it's built: processes, boundaries, invariants |
| [docs/osade/OSADE.md](docs/osade/OSADE.md) | Full spec: data model, invariants, milestones |
| [docs/osadexmoss.md](docs/osadexmoss.md) | Moss features spec: retrieval layer, multiplayer, attestation, compliance |

## Contributing

Issues and PRs are welcome. Adding an agent means a catalog entry plus a detection manifest, with
no orchestration changes. Behaviour branches on declared capabilities (`plan-mode`, `resume`,
`hook-reporting`, `headless-run`), never on which agent it is.

## License

Apache-2.0.