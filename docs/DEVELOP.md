# Developing for Task Orchestrator

TDD + SOLID. Read `TESTING.md` first for test conventions.

**First-time setup:** `git config core.hooksPath .githooks` (enables pre-commit + pre-push hooks)

**TypeScript strict** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`
- **Private fields** — `#name`, never `private name`
- **Imports** — `import type` for type-only, `verbatimModuleSyntax`
- **Files** — one class per file, barrel exports in `index.ts`
- **Tests** — see `TESTING.md`

### Before committing
1. `npm run c` — zero type errors (~2s, pre-commit hook enforces)
2. `npm run t` — all tests pass (~3s, pre-commit hook enforces)
3. `npm run all` — full pipeline (pre-push hook enforces)

### Environment variables
| Variable | Default | What it controls |
|---|---|---|
| `ORCH_REPO` | current directory | Target repo/folder override |
| `ORCH_STATE_ROOT` | `<home>\task-orchestrator` | Orchestrator state root override |
| `ORCH_TASKS` | `<state-root>\<repo-slug>\tasks` | Task directory override |
| `ORCH_MODEL` | pi default | Model override passed to `pi` |
| `ORCH_AUTO_STASH` | unset | Stash parent repo changes before merging |
| `ORCH_CONVERGE` | `3` | Zero-runs to converge |
| `ORCH_MAX_FAILURES` | `5` | Failed attempts before BLOCKED; integer >= 1 or `infinite` |
| `ORCH_KEEP_ALIVE` | unset | Keep looping through transient idle/cooldown periods |
| `ORCH_IDLE_SLEEP_MS` | `5000` | Sleep interval between keep-alive idle ticks |
| `ORCH_WORKTREES` | `<state-root>\<repo-slug>\worktrees` | Worktree directory override |
| `ORCH_HEARTBEAT_MS` | `300000` | Stale claim timeout |
| `ORCH_AGENT_LOG_MAX_BYTES` | `10485760` | Maximum `agent.log` size before older output is truncated |
| `ORCH_AGENT_LOG_RAW` | unset | Write raw spawned-agent stdout/stderr to `agent.log` |
| `ORCH_LOG_LEVEL` | `normal` | Console verbosity: `quiet`, `normal`, or `verbose`; quiet still writes full `orchestrator.log` |

CLI flags override env vars. See `orchestrator --help`.

Loop mode prints an `Overview:` counts line after each tick and a final `Summary:` with one line per task.

Unrecoverable merge failures park the task as BLOCKED, keep its worktree, and let the run continue.

### Task metadata

| Field | Values | What it controls |
|---|---|---|
| `**Retry limit:**` | integer >= 1, `infinite`, `unlimited`, or `inf` | Failed attempts before BLOCKED; falls back to `ORCH_MAX_FAILURES` |

Dependencies wait for all referenced tasks to converge; if any dependency is terminally BLOCKED, dependents are automatically BLOCKED transitively, while still-retrying FAILED dependencies keep dependents waiting.

---

## TDD: Red → Green → Refactor

```
1. RED   — Write test first. Watch it fail:     npm run t
2. GREEN — Minimum code to pass:                npm run t
3. REFAC — Clean up, keep tests green:          npm run all
```

**Skip RED only for**: pure interfaces/types, constants/enums, type-only fixes (caught by `tsc`).

## Before writing tests — map every branch

Read source, enumerate: **happy path**, **edge cases** (null, empty), **error paths** (every try/catch, guard clause, continue).

```
TaskState.pick() branches:
- Shard order: pending → in_progress → failed
- Per task: converged?→skip | blocked?→skip | failed+max_failures?→block
           | in_progress+unclaimed?→release | our claim?→return | actionable+claimable?→return
```

Each branch = one test case. Group by method:
```ts
describe('TaskState', () => {
  describe('pick', () => {
    it('returns pending task in numeric order', ...);
    it('skips converged tasks', ...);
    it('releases unclaimed in-progress tasks to FAILED', ...);
  });
});
```

## SOLID — applied

| Principle | What it means here |
|---|---|
| **S**ingle Responsibility | One class = one concern (`Status.ts` = enums, `TaskState.ts` = file state, `Engine.ts` = orchestration loop) |
| **O**pen/Closed | Depend on interfaces (`SpawnFn`, `BenchmarkFn`) — new behavior = new impl, not Engine changes |
| **L**iskov | Callback params are contravariant; return types covariant. Don't widen types in overrides. |
| **I**nterface Segregation | Keep interfaces focused (`TaskInfo` has 7 fields, not 20). Prefer `Pick<TaskInfo, 'directory'>` over full type. |
| **D**ependency Inversion | `Engine` depends on `SpawnFn` (abstraction), not `PiSpawner` (concretion). Wired by `cli.ts`. |

## Code review checklist

- [ ] Test written before code? (RED → GREEN)
- [ ] Every branch in source has a test case?
- [ ] `npm run tc` — 100% branch for changed files?
- [ ] `npm run c` — zero type errors?
- [ ] `import type` for type-only imports?
- [ ] `#privateField` not `private fieldName`?
- [ ] Isolated filesystem (`mkdtempSync`), mock at module boundary (`vi.mock('node:child_process')`)?
- [ ] `npm run all` — green?

## Adding a new file

`src/X.ts` → `tests/X.test.ts` → export from `src/index.ts` → `npm run all`

For test patterns (mocks, branch coverage, isolated filesystem), see `TESTING.md`.
