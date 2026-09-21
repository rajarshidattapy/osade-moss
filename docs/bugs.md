I went through the full Claude shipping log and deduplicated the issues. I excluded transient Claude-edit mistakes that were immediately corrected and kept actual product, test, documentation, deployment, and shipping gaps.

### Product / runtime issues

```text
1. Fix workspace, tab, and pane ID validation to accept the substrate's Crockford base-32 IDs instead of only decimal IDs.
2. Fix retrieval catch-up cursor handling because the cursor was stored as a timestamp but compared against a turn sequence number.
3. Fix ranked-only catch-up returning an empty result when the prompt shares no lexical tokens with recent activity; add a recency fill.
4. Fix duplicate/near-duplicate PR signals being written only in one direction so the older PR incorrectly appears unique.
5. Fix retrieval snapshot stamping so the cursor is captured before saving the snapshot; otherwise a newer cursor can mark a stale index as current.
6. Fix policy glob matching for trailing `**` and `**/` patterns such as `src/**` and `**/x.ts`.
7. Fix policy retrieval vocabulary mismatch where code identifiers like `apiKey` do not match policy text such as `API key`.
8. Fix the tree-sitter WASM dependency mismatch because `tree-sitter-wasms` built for an older ABI fails under the current `web-tree-sitter`.
9. Verify the real-agent migration canary end-to-end; the current suite only proves the gate logic with fake/injected model behavior.
10. Verify the complete discovery-miss → regression-fixture → export flow with a real seeded repository instead of only unit/integration coverage.
11. Verify the live agent self-learning path actually learns and reuses a sibling lane's verified fix; the real-agent path was not exercised.
12. Check that gate.commit and gate.push have real producers/integration paths; the log identifies them as having no producer.
13. Ensure missing/corrupt Moss indexes always degrade safely to FTS5 and trigger a rebuild rather than silently serving stale retrieval data.
14. Ensure context assembly failures never break agent launch and are surfaced clearly as degraded retrieval instead of disappearing silently.
15. Ensure stale retrieval citations are dropped when their underlying document no longer exists instead of returning broken references.
```

### Security / correctness issues

```text
16. Bind diff-bearing approvals to the exact `head_sha` being approved and re-read the branch head immediately before execution.
17. Ensure every diff-bearing SCM write path uses the same head-resolution function for approval-time pinning and execution-time verification.
18. Ensure synchronous gate execution cannot bypass the asynchronous head re-read protection.
19. Keep session tokens out of persistent storage; only store hashes and reject expired/revoked/wrong-scope tokens before exposing the ledger snapshot.
20. Enforce LAN mode as authenticated TLS before the server binds anywhere except loopback; never fall back to plaintext.
21. Keep role authorization deny-by-default and fail the build when a new router procedure is missing from the role matrix.
22. Verify attestation creation happens after the final head check and before the GitHub write so no PR can exist without the required attestation.
```

### Tests / CI / shipping reliability

```text
23. Remove the two remaining pre-existing lint failures: `headless-run.ts:96` prefer-const and `scripts/generate-substrate-client.mjs:76` unused variable.
24. Fix the CLI test environment so it does not resolve `Osade/docs` when running from the nested `osade-moss` workspace.
25. Fix or eliminate checkpoint-test flakiness under parallel execution; the test only became green when rerun in isolation.
26. Add real end-to-end coverage for the final LAN/auth/role/websocket posture instead of relying only on unit/integration tests.
27. Add regression tests for the workspace ID format so opening the 10th+ workspace cannot break launches.
28. Add regression tests for retrieval cursor units so timestamps and sequence numbers can never be mixed again.
29. Add regression tests for symmetric duplicate detection so both sides of a duplicate cluster receive the expected signal.
30. Add regression tests for `**` glob semantics and identifier-aware policy retrieval.
31. Add a real-agent acceptance test for the canary-to-verify path required by the migration criterion.
32. Remove repository pollution caused by `pnpm install` rewriting tracked generated `.bin` shims, or explicitly stop tracking those generated files.
```

### Documentation / repo hygiene issues

```text
33. Fix the README link from `docs/OSADE-MOSS.md` to the actual `docs/osadexmoss.md` file.
34. Add or correctly reference the missing `CONTRIBUTING.md` file.
35. Add or correctly reference the missing `LICENSE` file.
36. Remove the README claim that `gh auth login` is automatically reused; GitHub access currently comes from `OSADE_GITHUB_TOKEN`.
37. Mark Moss environment variables as planned/not wired unless the Moss retrieval backend is actually enabled.
38. Remove the README claim that authenticated TLS for teammates exists when the daemon is currently loopback HTTP only.
39. Change the README's retrieval latency claim from a guaranteed “under 30 ms” result to the documented p95 target.
40. Fix the stale `docs/moss-js-sdk.md` documentation because it references the old `@moss-dev/moss` package and outdated APIs instead of the current `@moss-js/moss`.
41. Fix stale documentation comments that point to nonexistent tests such as the old `test/integration/db.test.ts` location.
42. Remove the architecture filename typo `architechture.md` or rename it to `architecture.md` consistently.
43. Fix the root-vs-nested-repository documentation mismatch so setup commands and relative paths work from the actual shipped repository layout.
```

### Remaining product gaps found at the end

```text
44. Build the renderer UI for the newly implemented daemon features: policy details on gate cards, context-pack chip, presence avatars, and PR/triage signals.
45. Add built-in TLS certificate generation or a first-class certificate setup flow; LAN mode currently requires operators to manually provide `cert.pem` and `key.pem`.
46. Implement the post-sprint tier-2 attestation flow where the approver signs from their own device with a GitHub-published SSH key.
47. Add the missing UI for degraded retrieval and the retrieval-backend state instead of exposing the functionality only through daemon/CLI surfaces.
48. Exercise the entire shipped feature set from the real desktop renderer, not just daemon + contract + CLI tests.
```

The strongest source-confirmed issues at the end of the log are the four runtime bugs—cursor-unit mismatch, empty ranked catch-up, one-directional duplicate signals, and invalid workspace IDs—and the major remaining gap is that the new functionality still has no renderer UI. 

The original README audit also explicitly found the broken links, unsupported GitHub/Moss/TLS claims, and latency overclaim. 
