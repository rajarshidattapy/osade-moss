# Testing the Moss features

This guide covers the Moss-backed features added to Osade and the practical ways to
exercise them. The application source lives in `Osade/`; run the commands below from
that directory unless stated otherwise.

## What was added

| Feature | User-facing surface | What to look for |
| --- | --- | --- |
| Derived retrieval | `osade index stats`, `osade index rebuild` | The live backend, index backlog, document counts, and query latency. SQLite FTS5 is the safe fallback when Moss is not configured. |
| Cross-repository migrations | `osade migrate …` | Changelog-backed changes, a required human confirmation, code chunking, retrieval-versus-grep comparison, gated waves, and recorded misses. |
| Multiplayer controls | `osade team …`, `osade catchup` | Membership roles, a LAN join code when LAN mode is configured, and cited catch-up/history retrieval. |
| Signed PR evidence | `osade attest verify` | An approval is tied to the approved commit and is reported as valid, stale, absent, or invalid. |
| Policy and audit evidence | `osade policy …`, `osade audit export` | Versioned policy clauses on gates, explicit acknowledgements, and exportable decision evidence. |

Every row also has a desktop surface — see [In the desktop app](#in-the-desktop-app).

The terminal commands use the same daemon procedures as the desktop application. A
Moss project is optional: without `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY`, retrieval
uses the built-in FTS5 backend and remains fully testable.

## Automated checks

Install dependencies once, then run the normal repository check from `Osade/`:

```powershell
pnpm.cmd check
```

For just the Moss feature coverage:

```powershell
& .\node_modules\.bin\vitest.cmd run `
  packages/daemon/test/integration/retrieval.test.ts `
  packages/daemon/test/integration/migration.test.ts `
  packages/daemon/test/integration/multiplayer.test.ts `
  packages/daemon/test/integration/attestation.test.ts `
  packages/daemon/test/integration/policies.test.ts `
  packages/daemon/test/integration/signals-audit.test.ts
```

The browser/substrate acceptance tests require a local runtime and are opt-in:

```powershell
$env:OSADE_E2E = '1'
pnpm.cmd test:e2e
```

## Run a disposable local instance

Use a throwaway `OSADE_HOME` so manual tests never alter your regular Osade database.
Build the two command-line entry points, start the daemon in one terminal, and keep it
running while using a second terminal for the commands.

```powershell
pnpm.cmd --filter @osade/daemon build
pnpm.cmd --filter @osade/cli build

$env:OSADE_HOME = Join-Path $env:TEMP 'osade-moss-manual-test'
New-Item -ItemType Directory -Force $env:OSADE_HOME | Out-Null
node packages/daemon/dist/cli.js start --port 0
```

In a second PowerShell window, set the same `OSADE_HOME` and define a local command function:

```powershell
$env:OSADE_HOME = Join-Path $env:TEMP 'osade-moss-manual-test'
function osade { & node packages/cli/dist/bin.js @args }
osade index stats
```

`index stats` should name the selected backend and show no pending rows once the indexer
is caught up. `index rebuild` is intentionally safe to run at any time:

```powershell
osade index rebuild
```

When finished, stop the daemon with `Ctrl+C`. Delete the throwaway directory only if you
no longer need its logs or database.

## Migration walkthrough

This is the quickest full terminal walkthrough. It deliberately uses a manually entered
change, so it works without an agent or model credential.

1. Create a small Git repository containing a JavaScript or TypeScript call to the old
   API, then commit it. Set `$repo` to its absolute path. For a realistic discovery
   comparison, include a direct call plus a wrapper that does not contain the old symbol.
2. Register the repository and capture its internal id. `repoOpen` is the same local
   procedure used by the desktop app; this temporary PowerShell helper only makes its id
   visible for the terminal-only walkthrough.

```powershell
$port = (Get-Content (Join-Path $env:OSADE_HOME 'daemon.port')).Trim()
$base = "http://127.0.0.1:$port"
$body = @{ path = (Resolve-Path $repo).Path } | ConvertTo-Json
$reply = Invoke-RestMethod "$base/repoOpen" -Method Post -ContentType 'application/json' -Body $body
$repoId = $reply.result.data.repoId
```

3. Make a changelog file, create the migration, add the change, and explicitly confirm it.
   The confirmation is the required human gate; target assignment, chunking, discovery,
   and launch must fail before it happens.

```powershell
@'
# 2.0.0
- `search()` was renamed to `query()`.
'@ | Set-Content .\CHANGELOG-test.md

$migrationId = osade migrate new npm '@moss-js/moss' 2.0.0 .\CHANGELOG-test.md
osade migrate add-change $migrationId rename search query 'search was renamed to query'
osade migrate confirm $migrationId
osade migrate target $migrationId $repoId
osade migrate chunk $migrationId
osade migrate discover $migrationId
osade migrate show $migrationId
```

`migrate show` reports candidate sites as `both`, `moss`, and `grep`. `moss` is a
retrieval-only match; `grep` is a grep-only match. Both are deliberately recorded so the
comparison cannot hide misses. Use `migrate misses <id>` to inspect verification-discovered
misses, or `migrate misses <id> --export <directory>` to turn them into fixtures.

`migrate launch <id>` starts only wave 0 initially. Later waves remain blocked until a
canary has a passing required verification run. `migrate metrics <id>` prints the
digest-on/digest-off comparison and labels small samples as demonstrative rather than
conclusive.

On Windows, repository paths are canonicalized before storage. To check that regression,
register a repository through the desktop app or `repoOpen`, then create a task for the same
checkout using the other slash style:

```powershell
osade task create $repo 'path-normalization probe'
```

The repository must remain a single logical repository; migration targets and indexed chunks
must not split across two repository ids.

## Policies, attestation, and audit trail

Reload repository policies after editing `.osade/policies/*.md` in the repository:

```powershell
osade policy reload
```

When an agent creates a diff-bearing gate, inspect the clauses with `osade policy show
<gate-id>`. Clauses marked `NEEDS ACK` require `osade policy ack <gate-id> <clause-id>` before
approval is available. This is easiest to exercise from a real task in the desktop app because
gate ids are created by verification and approval flows.

To verify a PR attestation, save its body to a file and compare it with the current branch head:

```powershell
osade attest verify .\pr-body.md (git rev-parse HEAD)
```

The audit keeps the clauses a gate was shown even after the policy file is edited or
deleted: each gate stores its own copy of the citation (migration 18). To check, approve a
gate that cited a clause, edit or delete the policy file, run `osade policy reload`, and
confirm `osade audit export` still lists the clause and its ack. A gate that has *not*
executed yet is unbound instead, so its approval fails the re-hash rather than running
against rewritten policy.

Export the recorded gate evidence as JSON Lines (default) or CSV:

```powershell
osade audit export --since 2026-01-01
osade audit export --since 2026-01-01 --format csv
```

## In the desktop app

Start the app against the same throwaway home so it adopts the daemon you already started:

```powershell
$env:OSADE_HOME = Join-Path $env:TEMP 'osade-moss-manual-test'
pnpm.cmd --filter @osade/desktop start
```

**Workspace panel.** The sidebar foot has a **Retrieval** row showing the live backend, and
clicking it (or the **Workspace** row under it) opens a panel with five tabs:

| Tab | What to check |
| --- | --- |
| Retrieval | Backend is `Local (FTS5)` without Moss credentials, `Moss` with them, `Degraded · FTS5` with the reason when Moss is configured but failing. Per-namespace docs, queries, p50/p95, and indexer lag. **Rebuild index** re-projects from SQLite and reports the count. |
| Migrations | **New migration** takes provider, package, versions and a pasted changelog. The detail view walks the same steps as the CLI walkthrough above: add or extract changes, **Confirm changes** (targets, chunking and discovery stay disabled until then), tick target repos, **Parse and chunk**, **Discover**. Discovery shows a both / retrieval-only / grep-only table and bar per repo. **Launch wave N** is only enabled for the next wave, and wave 1+ waits for a green canary. The digest A/B table and discovery misses appear once lanes have run. |
| Team | Listening mode, join code and TLS fingerprint in LAN mode, the member list with role changes and removal, and an invite form. The owner row cannot be changed. |
| Pull requests | Pick a repo to see the triage list (attested → unique → near-duplicates) with attestation state and similar PRs. **Check an attestation** takes a PR body and head sha and reports valid, stale (approved an earlier commit, not forged), invalid, or absent. |
| Policies & audit | **Reload policies** shows policies / clauses / removed. **Download .jsonl** exports the audit rows for the last N days, optionally for one repo — the same bytes as `osade audit export`. |

**On a gate card.** When a gate's diff touches a policy clause, the card lists each clause
with its ref, title, text, source file and file hash. A `requires_ack` clause has a checkbox;
**Approve** (and **Approve edited**) stay disabled until every such clause is acknowledged,
and the acknowledgement names who made it. The daemon refuses the approval regardless of the
button, so the Enter shortcut cannot skip it.

**On a lane.**
- Below the transcript, a **Context** chip shows the pack sent with the latest turn — item
  count, tokens, backend, and whether it was degraded. Click it to see every cited item with
  its namespace, source row and score.
- **Catch up** (next to the Chat / Terminal switch) lists what happened in the chat since you
  last looked. Items marked `●` were included by exact filter (gate decisions, verify failures)
  rather than by ranking. The box underneath asks the chat's history and returns cited hits.
- Under the lane strip, an attested lane shows `✓ attested <sha> · <login>`. Once teammates
  exist, the same row shows who is on the lane and a **Claim** / **Driving: … · release**
  button. The claim is advisory; it does not lock the lane.

**Owner access once teammates exist.** The daemon writes a fresh host token to
`$OSADE_HOME/daemon.token` at every boot. The desktop app and the `osade` CLI present it, which
is how they stay the owner after someone is invited. Anonymous requests are still refused. To
check: invite someone from the Team tab, then confirm the app keeps working and
`osade task list` still answers. The raw `Invoke-RestMethod` helper in the migration
walkthrough sends no token, so it only works while nobody is invited — add
`-Headers @{ Authorization = "Bearer $((Get-Content (Join-Path $env:OSADE_HOME 'daemon.token')).Trim())" }`
after that.

The same surfaces can be exercised with the smoke harness. It boots the real window against a
seeded throwaway home, runs a sequence of clicks (`>>` between selectors), writes a screenshot,
and fails if any expected phrase is not visible. The seed adds a gate with two policy clauses
(one `requires_ack`) and a context pack. Use an absolute `OSADE_HOME`: the global policy is keyed
by its path, and a relative home would make the daemon see a different file at boot.

```powershell
cd apps/desktop
pnpm.cmd --filter @osade/daemon build; pnpm.cmd build
$env:OSADE_HOME = (Resolve-Path .smoke).Path
pnpm.cmd --filter @osade/daemon exec vite-node scripts/seed-smoke-fixture.mjs $env:OSADE_HOME
$env:OSADE_SMOKE_SHOT = 'smoke-moss.png'

# Workspace panel (click "Not now" first on a fresh home: '[data-github-skip] >> ...')
$env:OSADE_SMOKE_CLICK = '[data-open-workspace]'
$env:OSADE_SMOKE_EXPECT = 'Backend|Indexer lag|Rebuild index|Migrations|Pull requests'
npx electron .

# Gate clauses: Approve is held, the ack releases it
$env:OSADE_SMOKE_CLICK = '[data-task-id] >> [data-ack]'
$env:OSADE_SMOKE_EXPECT = 'SEC-3.2|Acknowledged by owner|Context · 1 item'
npx electron .
```

`apps/desktop/.smoke` is committed, so restore it afterwards with
`git checkout -- apps/desktop/.smoke` and delete the untracked files the run leaves there.

## Multiplayer status

The membership and cited-history procedures are covered by the automated integration tests.
For a local smoke check:

```powershell
osade team list
osade team share
```

By default the daemon is loopback-only, so `team share` correctly reports that no join code is
available. A shareable session requires the LAN/TLS configuration; never expose the local
daemon over plaintext HTTP.
