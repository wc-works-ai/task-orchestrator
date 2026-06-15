# Developing for Task Orchestrator

**Test-first (TDD) is mandatory: write a failing test before the implementation it covers.** Then SOLID. Read `TESTING.md` first for test conventions.

## Core workflow — Red → Green → Refactor

```
1. RED   — Write the test first. Run it and watch it FAIL:   npm run test:unit
2. GREEN — Write the minimum code to make it pass:           npm run test:unit
3. REFAC — Clean up with the tests green:                    npm run all
```

**Rule: never write production code before there is a failing test that demands it.** The only exceptions (no RED needed): pure interfaces/types, constants/enums, and type-only fixes already caught by `tsc`.

Tests are tiered (unit / integration / e2e) — see `TESTING.md`. Use the fast `test:unit` loop while iterating; the full gate runs at pre-push.

**Setup:** `git config core.hooksPath .githooks` (enables pre-commit + pre-push hooks)
Maintenance: When adding new docs relevant to coding agent behavior, update `docs/INDEX.md`; avoid adding direct links to `AGENTS.md` unless absolutely required.

**TypeScript strict:**
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`
- Private fields: `#name`, never `private name`
- Imports: `import type` for type-only, `verbatimModuleSyntax`
- Files: one class per file (exception: a cohesive type hierarchy like `errors.ts`); barrel exports in `index.ts`

## Before committing

1. `npm run c` — zero type errors
2. `npm run test:unit` — fast unit tier (what pre-commit runs)
3. `npm run tc` — 100% coverage on unit+integration (mandatory; blocks merge)
4. `npm run test:e2e` + `npm run b` — full pre-push gate

Pre-commit runs `c` + `test:unit` (fast); pre-push runs the full gate. See `TESTING.md` for tiers.

## Environment variables

See `README.md` for configuration tables. CLI flags override env vars. Settings defined once in `src/shared/config.ts` (`CONFIG_SPEC`).

Use `orchestrator --config` to inspect effective values and their sources.

#### Style conventions

- File naming: `PascalCase.ts` when the primary export is a class (`Engine.ts`) or an eponymous type (`CodingAgent.ts`, `BenchmarkMeta.ts`, `Status.ts`); `camelCase.ts` for utility/function/value/collection modules (`config.ts`, `errors.ts`, `agents.ts`, `addTask.ts`, `cli.ts`)
- Type names: PascalCase, no `I` prefix; suffixes `…Options`, `…Fn`, `…Result`
- Constants: `UPPER_CASE` for module constants; PascalCase for enum-like objects
- Variables/functions: `camelCase` (`snake_case` only in DB-row types mirroring SQLite columns)
- Top-level helpers: `function` for utilities; arrow-const for single-expression helpers

#### Error handling

- **Never swallow errors silently** (`catch {}` or `catch { /* ignore */ }`)
- **Never monkey-patch** — fix root causes; if a fix needs another fix, the first was wrong
- Every `catch` must either: **log** the error, **rethrow** it, or **return a meaningful fallback**
- `catch {}` is only acceptable for truly inconsequential best-effort operations (e.g., deleting a temp file that may not exist)
- When in doubt, **log at minimum** — silent swallowing makes debugging impossible

## Task metadata

| Field | Controls |
|---|---|
| `**Model:**` | Task-level model override |
| `**Reasoning:**` | Task-level reasoning override |
| `**Retry limit:**` | Failed attempts before BLOCKED |

Dependencies wait for all referenced tasks to converge. If any is terminally BLOCKED, dependents auto-BLOCKED.

Environment failures (missing API key, agent auth) fail fast — affected task is FAILED without consuming a retry.

## Coding agents

`pi` (default) uses pi's experiment tools. `copilot` uses the GitHub Copilot CLI.

Both interact with orchestrator ONLY through `CodingAgent` interface (`checkPrerequisites` + `spawn`).

### Adding a new coding agent

1. Write `tests/unit/<Name>Agent.test.ts` first (prerequisites + spawn behavior, mocked) — RED
2. Create `src/agent/<Name>Agent.ts` implementing `CodingAgent` interface — GREEN
3. Register in `src/agent/agents.ts` `REGISTRY`
4. Run `npm run all`

---

## TDD in practice — a worked example

Adding `TaskState.unblock()` test-first:

```ts
// 1. RED — write the test before the method exists; it fails to compile/run.
it('unblock resets a blocked task to pending with cleared failures and claim', () => {
  const t = blockedTask(tdb, tasksRoot);   // a BLOCKED task view
  t.unblock();                             // ← method does not exist yet → RED
  expect(t.status).toBe(Status.PENDING);
  expect(t.failureCount).toBe(0);
  expect(t.isClaimed).toBe(false);
});
```

```ts
// 2. GREEN — minimum implementation: delegate to the DB layer.
unblock(): void {
  this.#tdb.unblock(this.#id);
}
```

```
// 3. REFACTOR — tidy, keep green: npm run all
```

## Before writing tests — map every branch

Read source and enumerate: **happy path**, **edge cases** (null, empty), **error paths** (every try/catch, guard, continue).

Each branch = one test case. Example:

```ts
describe('TaskState.pick', () => {
  it('returns pending task in numeric order', ...);
  it('skips converged tasks', ...);
  it('releases unclaimed in-progress tasks to FAILED', ...);
});
```

## SOLID — applied

| Principle | Means |
|---|---|
| **S** | One class = one concern (Status.ts = enums, TaskState.ts = file state) |
| **O** | Depend on interfaces (`SpawnFn`, `BenchmarkFn`) — new behavior = new impl |
| **L** | Don't widen types in overrides |
| **I** | Keep interfaces focused (`TaskInfo` = 7 fields, not 20) |
| **D** | `Engine` depends on abstraction, not concretion (wired in `cli.ts`) |

## Code review checklist

- [ ] Test written first (RED → GREEN)?
- [ ] Every branch tested?
- [ ] `npm run tc` — 100% coverage?
- [ ] `import type` for type-only imports?
- [ ] `#privateField` not `private fieldName`?
- [ ] Isolated filesystem, mocked at module boundary?
- [ ] `npm run all` passes?

## Adding a new file (test-first)

`tests/{unit|integration}/X.test.ts` (write failing tests first — pick the tier by what it touches) → `src/<domain>/X.ts` (implement to green; see `ARCHITECTURE.md` for domains) → export from `src/index.ts` → `npm run all`

For tiers, mocks, branch coverage, and the E2E harness, see `TESTING.md`.
