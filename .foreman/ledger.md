# Foreman ledger — wp-fleet-mcp
Mode: Full (Agent + shell, no Codex). LEAD: opus-5-5.
Baseline: git init, commit "chore: spec" (see below).

| Task | Seat | Write set | Status |
|---|---|---|---|
| W1 scaffold+core+sites+docker | sonnet | root configs, Dockerfile, compose, src/{index,server,http,audit}.ts, src/config/*, src/wp/*, src/tools/{context,helpers,index,sites}.ts, stub tool modules, tests/core/* | PENDING |
| W2a plugins/themes/updates/fleet tools | sonnet | src/tools/{plugins,themes,updates,fleet}.ts, tests/tools/{plugins,themes,updates,fleet}.test.ts | PENDING |
| W2b users/content/settings tools | sonnet | src/tools/{users,content,settings}.ts, tests/tools/{users,content,settings}.test.ts | PENDING |
| W2c PHP bridge | sonnet | wordpress/** | PENDING |
| W3 README + verify | sonnet/verifier | README.md | PENDING |

## Attempts (append-only)
- W1 attempt 1 (sonnet): DONE, commit f221d87, 52 tests, 94% lines. Lead spot-check green.
- W2a/W2b/W2c dispatched in parallel (sonnet), disjoint write sets, baseline f221d87.
- W2 all DONE; refactor commit; bridge b18091d; README da00798.
- Verify #1 (blind, @da00798): FAIL — 1 CRITICAL (http/unavailable sites contacted), 4 HIGH (http host check, shared stateless server, update_core, get_plugins include), 3 MED, 3 LOW.
- Fix wave dispatched: TS worker (src/tests/README/compose) ∥ PHP worker (wordpress/**).
- Verify #2 @a92a3a9: PASS_WITH_NOTES (11/11 fixed; 2 MED new: update audit ok on failure, core autoupdate offers). Fix round 2 dispatched TS ∥ PHP.
- Verify #3 @aa6a4fd: FAIL — HIGH regression (stale /updates read skips updates), MED core preview, MED translations null, LOW core up-to-date as error. Round 3 dispatched TS ∥ PHP (contract: no_update:true).
