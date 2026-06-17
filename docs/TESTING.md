# Testing

A pyramid — fast/many at the base, slow/few at the top. Tier by what a test
*touches*, not by file: a module may have tests in several tiers.

## Tiers

| Tier | Touches | Lives in | Speed |
|------|---------|----------|-------|
| **unit** | mocked / pure logic, no real I/O | `tests/unit/` | ~3s |
| **integration** | real `:memory:` SQLite, temp FS, real git (in-process) | `tests/integration/` | ~38s |
| **e2e** | the real `orchestrator` CLI as a spawned process + real git | `tests/e2e/` | ~70s |

Shared helpers live in `tests/shared/`. Vitest `projects` keys each tier by directory.

## Coverage (the gate)

**100% branch coverage on unit + integration combined** is a non-negotiable merge gate:
- `npm run tc` runs unit+integration with coverage; fails below 100% on any metric.
- E2E is **pass/fail confidence — not coverage-gated** (process-level coverage is noisy).
- `npm run cov:unit` shows the unit tier's coverage alone (informational — pyramid shape).

Don't mock what's cheap to run for real (`:memory:` SQLite, temp FS) — that tests mocks, not reality.

## Commands

| Command | Runs |
|---------|------|
| `npm run test:unit` | unit tier (fast inner loop) |
| `npm run test:int` | integration tier |
| `npm run test:e2e` | e2e tier |
| `npm run tc` | unit+integration + **100% coverage gate** |
| `npm run test:all` | every tier |
| `npm run tw` | watch |

## When to run

| Stage | Runs |
|-------|------|
| Dev watch | `test:unit` |
| Pre-commit hook | `c` + `test:unit` (fast) |
| Pre-push hook | `c` + `tc` (100%) + `test:e2e` + `b` |
| CI (GitHub Actions) | same as pre-push, on Linux |

## Writing tests

Map every branch first: happy path + edge case + error path.

- **unit:** mock at the module boundary (`vi.mock('node:child_process')`) or inject
  collaborators (Engine takes `taskDb`/`benchmark`/`spawn`; `TaskState.fromRow` takes any TaskDb).
- **integration:** real `:memory:` TaskDb + `mkdtempSync` dirs + real git. No I/O mocks.
- **e2e:** drive the CLI via `tests/shared/e2e.ts`. Determinism = the `exec` agent
  (`ORCH_AGENT=exec` + a scripted command) + scripted benchmarks + external git. **No real LLM.**

## E2E scenarios

Mirror `WORKTREE_SYNC.md`: convergence→merge, base-advanced sync, sync/merge-back
conflict→BLOCKED, verifyCmd→rework, auto-stash, branch restore, merge-lock retry,
dependency gating/cascade, `--unblock`, max-failures→BLOCKED, stale-claim recovery,
restart mid-convergence, startup reconciliation, no-worktree, migration. Genuinely
non-deterministic cases (e.g. SIGKILL mid-merge) stay at the integration tier.

The real pi/copilot agent runs only via `npm run smoke:live` — a manual, non-gated
check (needs credentials; skips cleanly without them).
