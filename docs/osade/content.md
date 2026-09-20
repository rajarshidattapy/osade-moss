# Landing page content

Content spec for the Osade site. Marketing register, not the README — the README is the
install-and-run document, this is the "why would I open this" document. Every claim here is
checkable against `docs/OSADE.md` or the code; nothing aspirational is written in the present
tense. Shipped and unshipped are separated at the bottom rather than blended.

Voice follows §19.4: active, sentence case, no apologizing. An action keeps its name through the
whole flow.

---

## Hero

# Osade

## Run all your coding agents together on real repositories.

One desktop app. Your agents, your machine, your call on anything that ships.

Local-first · Bring your own agent · Nothing leaves your machine

[Get started] [View on GitHub]

---

## The problem is review, not code

Open source is closing the door on autonomous AI contributions. Godot banned autonomous agent
use. curl shut down its bug bounty. Maintainers report roughly 1 in 10 AI PRs meets their bar.

The bottleneck is **review capacity**, not code production.

So a tool that helps you open more agent PRs makes the problem worse.

Osade is built for the opposite goal:

> **Reduce the review cost of a contribution until an agent-assisted PR is cheaper to review
> than a human one.**

That sentence is why verification, evidence-cited conventions and human gates are core here
rather than settings you can turn on later.

---

## Start by typing, not by configuring

A new chat is an empty box. Type, and an agent starts working in a terminal you don't have to
look at.

Branch names and titles come from what you wrote.

```text
you           "fix the token refresh race in the auth client"
                     ↓
Osade         branch: agent/auth-refresh-race
              agent:  claude
              lane:   implementing
```

No task form. No YAML. No pre-flight configuration to get one agent moving.

---

## Several agents. One conversation.

Put `@claude` and `@codex` on separate lines and the message fans out to both. Each gets its own
branch and its own worktree, and they share one transcript.

```text
@claude  take the parser
@codex   write the regression test

         ↓                    ↓
  agent/parser-fix      agent/parser-test
     Claude Code            Codex
         │                    │
         └──── one chat ──────┘
```

Each agent receives a short digest of what the others have done, so they're not working blind
next to each other.

Supported today: **Claude Code**, **Codex**, **OpenCode**, **Pi**.

Osade branches on declared capabilities — `plan-mode`, `resume`, `hook-reporting`,
`headless-run` — never on which agent it is. Adding one is a catalog entry plus a detection
manifest, not an orchestration change.

---

## It doesn't ship a model

Osade is not another AI. It's the environment around the agents you already pay for.

```text
                    OSADE
                      │
        ┌─────────────┼─────────────┬──────────┐
        │             │             │          │
   Claude Code      Codex       OpenCode      Pi
        │             │             │          │
        └─────────────┴──────┬──────┴──────────┘
                             │
                    worktrees · verification
                             │
                          gates
                             │
                          GitHub
```

It drives the agent CLIs on your `PATH`. Switch agents without changing your workflow.

---

## Your real checkout stays your real checkout

Most agent tools drop you into a branch you didn't ask for. Osade doesn't.

The first chat in a repo attaches to your working tree, on whatever branch is already checked
out. Branch out when you're ready — uncommitted changes come with you.

Additional chats and extra agents get isolated worktrees automatically, so two agents are never
writing to the same tree.

```text
your-repo/
│
├── main                     ← first chat, your actual checkout
│
├── agent/parser-fix         ← worktree
│   └── Claude Code
│
└── agent/parser-test        ← worktree
    └── Codex
```

Parallel work without stepping on each other. Jump into any of them and take over.

---

## Every repository has a way of working

Agents know how to code. They don't know how **your project** works.

What gets a PR merged is conformance to a project's tacit rules — and those rules are already in
the record. In review comments. In what got rejected. In the diff between what was submitted and
what was merged.

Nobody treats that record as a mineable artifact. Osade does.

```text
closed-unmerged PRs      ─┐   highest signal — rejection is
changes-requested threads ┤   the strongest signal and everyone ignores it
head-vs-merge diffs       ┤
merged-PR review comments ┤
CONTRIBUTING / CODEOWNERS ┤
CI config                ─┘   mechanically enforced, so definitionally true
                  ↓
        extract → cluster → verify
                  ↓
          Repository skills
```

### A rule without evidence is not a rule

Every mined rule carries at least one link to a real PR or thread. Rules that can't be cited are
rejected at write time, and candidates are tested against merged PRs the miner hasn't seen — if
merged PRs routinely violate a rule, it's marked rejected rather than shipped.

```text
Rules this project enforces

✓ one concern per PR, no drive-by refactors
    evidence: PR #1234 (closed unmerged), PR #1290 (changes requested)
✓ integration tests required for anything touching the client
    evidence: .github/workflows/pr.yml
✓ discuss API changes on the issue before implementing
    evidence: PR #1187 (changes requested), PR #1402 (closed unmerged)
```

The active rules are rendered into the agent's context at launch, capped — 40 rules, ~2000
tokens, ranked by confidence and recency. A 200-rule context file is worse than none.

The same agent behaves differently in a different repository, because the repository is
different.

---

## Verification before it costs a maintainer anything

Osade derives a verification plan from evidence, not guesses: your PR-triggered CI workflows
first, then package manifests, then what CONTRIBUTING says.

It shows you the plan and lets you edit it. An inferred command never runs silently the first
time, and a CI step it can't resolve is reported as skipped rather than invented.

```text
agent writes code
       ↓
verification runs in its own lane, where you can watch it
       ↓
   fails?  ──→  failing command + log tail goes back to the agent
       ↓                              ↺
   passes  ──→  reviewable
```

That closed loop — agent acts, environment answers, agent adapts — is the whole point.

Verification has to pass before a pull request can be opened.

---

## The best thing an agent can do is often not open a PR

A maintainer will accept a bot that saves them 40 minutes of triage long before they accept a bot
that adds to their review queue.

Osade has a task type that terminates in an artifact instead of a pull request:

```text
reproduce        does the reported bug actually reproduce, in a clean worktree?
bisect           which commit introduced the regression?
failing-test     a test that demonstrates the bug
duplicate-check  does this issue already exist?
verify-pr-claim  does a human's PR do what its description says?
```

No PR. Just the answer, with the evidence attached.

---

## Nothing leaves your machine without you

Commits are local and reversible. Everything that becomes public is gated.

```text
read / edit / test     →  auto
commit                 →  auto, reversible via checkpoint
push                   →  you
open pull request      →  you, and only after verification passes
PR / issue comment     →  you            (public speech)
submit review          →  you            (public speech)
force-push             →  you, never overridable
create fork            →  you, never overridable
add dependency         →  you            (supply chain)
merge                  →  Osade never merges. Ever.
```

A gate card shows the exact action, the rendered diff or the literal comment text, which task it
came from, and the verification state. Approve, deny, or edit and approve.

The payload is hashed when the gate is requested and re-hashed when it executes. If the text
changed in between, it aborts — an "approve this comment" decision can't be executed against
different words.

Batch approval exists for local commits only. Never for a public write.

---

## Shared memory that can't poison itself

Agents share what they learn, across five scopes: personal, organization, repository, task,
agent.

But shared agent memory is the easiest feature in this category to get actively wrong. One
agent's wrong guess becomes every future agent's ground truth.

So two rules are load-bearing:

**Nothing gets promoted above task scope without verification.** An unverified discovery stays
task-local and dies with the task. A claim reaches repo or org scope only when a verification run
confirmed it empirically.

**Conventions never transfer across repositories.** What's true for repo A is false for repo B.
What does travel is ecosystem-level know-how, and only when it's tagged as such — "under pnpm
workspaces, run tests with `--filter` to avoid the full graph" is portable; "this project wants
RFCs first" is not.

Every entry keeps its source task, source agent and timestamp. Tooling notes expire. Superseded
entries are marked, not deleted.

You can read and delete any of it. A shared memory you can't inspect is a shared memory you can't
trust.

---

## Watch it, or don't

Files, Checks, Diff and Rules sit next to the chat. The composer stays live on all of them and
attaches whatever you're looking at — so "why did you change this" works while you're reading the
hunk.

```text
agent working
      ↓
open the terminal it's actually running in
      ↓
inspect the diff, read the checks, read the mined rules
      ↓
take over, or send it back with a note
```

Watching an agent live opens a real terminal attached to the same session. No replay, no mirror,
no black box.

---

## Your agents outlive the window

Three processes. Two of them keep running after you close the app.

```text
Electron app        chats, lanes, files, diffs, checks, gates
      │  tRPC + WebSocket, 127.0.0.1 only
Osade daemon        lifecycle, verification, gates, GitHub, conventions, memory
      │             SQLite + change_log + CDC
      │  JSON API over a local socket
terminal substrate  PTYs, worktrees, agent detection, session persistence
```

Close the window. Agents keep working. GitHub keeps polling. Verification keeps running. Come
back and the worktrees, sessions, task state and transcripts are where you left them.

Osade doesn't reimplement terminals — a headless Rust substrate owns PTYs, VT parsing, git
worktrees and agent process detection.

---

## Local-first, and specific about it

- The daemon binds `127.0.0.1`. There is no remote mode, no hosted service, no multi-tenant
  anything.
- GitHub tokens live in the OS keychain via Electron `safeStorage`, held in memory by the daemon,
  never written to a config file.
- Everything Osade writes lives in `~/.osade` (`%USERPROFILE%\.osade` on Windows). Delete that
  directory and it's as if you never ran it.
- Already have `gh auth login`? Osade reuses it instead of asking you to authorize a second OAuth
  app.

macOS, Linux and Windows.

---

## Two things worth knowing if you read the code

**There is no `status` column.** Task status is a pure function over durable facts — what the
substrate observed, what verification returned, what GitHub reported — recomputed on every read.
A flaky probe can't kill a live agent.

**There is one event path.** Every change reaches the UI through a SQLite trigger into
`change_log`. If the UI didn't update, the write didn't go through the database.

Both are the kind of decision that's cheap on day one and impossible to retrofit.

---

## Built for the people doing the reviewing

### Contributors
Work across projects without carrying each one's unwritten rules in your head.

### Maintainers
Get contributions that follow your project's practices, with the evidence for why they were
followed.

### Agent developers
A persistent environment with real worktrees, real verification and real gates to operate in.

---

## What it looks like

Dark, monospaced, square-cornered — it should look like the terminal it sits beside.

The main view is a ledger, not a kanban board: one vertical list, ruled rows, sorted needs-you
first. With eight agents running, the question you're actually asking is "who needs me?", and
columns answer that worse than a sorted list does.

```text
⚑ gate    open PR      auth-refresh
⚑ input   needs you    csv-import
● live    implementing rate-limit
✗ fail    verify       parser-fix
○ idle    queued       docs-typo
── merged ──────────────────────────
✓ merged  pr #4421     null-guard
```

Color means state and nothing else. One blue accent, and it means "this is what you're on."

---

## From issue to contribution

```text
Understand   →  import the issue, or just describe the work
Isolate      →  its own worktree, its own branch
Execute      →  the agent you chose, under this repo's mined rules
Verify       →  this repo's real checks, failures fed back
Review       →  diff, checks, evidence, in one window
Ship         →  behind a gate you approve
Remember     →  verified knowledge promoted, the rest discarded
```

---

## Status

**Early and moving fast. Usable, not stable.**

Working today: chat-driven agent launch, multi-agent fan-out, worktree isolation, derived status,
verification plans and the failure loop, approval gates, checkpoints and undo, GitHub issue
import and gated PR writes, triage tasks, the conventions miner and context injection, and
layered memory.

Not yet: organization workspaces and the cross-repo ledger, network egress enforcement, and the
embedded terminal surface — watching an agent live opens a real terminal client for now, which is
a deliberate deferral (ADR 0001), not an oversight.

The one number this project is trying to move is **review rounds to merge**. It's instrumented.
If the conventions miner doesn't move it, that gets reported rather than buried.

---

## Footer

# Osade

### Run coding agents as open-source contributors.

Local-first. Multi-agent. Git-native. Human-gated. Apache-2.0.

[Get started] [GitHub] [Read the spec]

---

## Notes for whoever builds this page

**Naming.** "Osade" stands on its own — don't expand it to an acronym in the hero. If an
expansion is needed anywhere, it belongs in an about section, not above the fold.

**The one line to lead with**, from the README and used verbatim above:

> Run all your coding agents together on real repositories — from one desktop app.

It says what the thing is in one read. The review-cost thesis is the second screen, not the
first — it's the argument, and arguments don't go in heroes.

**Don't claim Gemini, Aider or Cursor support.** The catalog is Claude Code, Codex, OpenCode and
Pi (`packages/daemon/src/domain/agent-catalog.ts`). Any earlier draft listing others was wrong.

**Don't say "built on Code-OSS."** Osade is an Electron desktop app over a headless Rust terminal
substrate. It is not an editor fork and does not try to be your IDE.

**Don't promise autonomy.** Every section that could read as "it ships code for you" should land
on the gate instead. The product's claim is trustworthy contribution, not unattended
contribution.
