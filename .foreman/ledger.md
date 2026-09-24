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
