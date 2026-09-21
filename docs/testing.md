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

Export the recorded gate evidence as JSON Lines (default) or CSV:

```powershell
osade audit export --since 2026-01-01
osade audit export --since 2026-01-01 --format csv
```

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
