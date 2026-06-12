# Developing for Task Orchestrator

TDD + SOLID. Read `TESTING.md` first for test conventions.

**Setup:** `git config core.hooksPath .githooks` (enables pre-commit + pre-push hooks)
Maintenance: When adding new docs relevant to coding agent behavior, update `docs/INDEX.md`; avoid adding direct links to `AGENTS.md` unless absolutely required.

**TypeScript strict:**
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`
- Private fields: `#name`, never `private name`
- Imports: `import type` for type-only, `verbatimModuleSyntax`
- Files: one class per file, barrel exports in `index.ts`

## Before committing

1. `npm run c` — zero type errors
2. `npm run t` — all tests pass
3. `npm run tc` — 100% coverage (mandatory; blocks merge)
4. `npm run all` — full pipeline

## Environment variables

See `README.md` for configuration tables. CLI flags override env vars. Settings defined once in `src/config.ts` (`CONFIG_SPEC`).

Use `orchestrator --config` to inspect effective values and their sources.

#### Style conventions

- File naming: PascalCase for classes (`Engine.ts`); lowercase for utilities (`env.ts`, `cli.ts`)
- Constants: `UPPER_CASE` for module constants; PascalCase for enum-like objects
- Top-level helpers: `function` for utilities; arrow-const for single-expression helpers

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

1. Create `src/<Name>Agent.ts` implementing `CodingAgent` interface
2. Register in `src/agents.ts` `REGISTRY`
3. Run `npm run all`

---

## TDD: Red → Green → Refactor

```
1. RED   — Write test first. Watch it fail:     npm run t
2. GREEN — Minimum code to pass:                npm run t
3. REFAC — Clean up, keep tests green:          npm run all
```

**Skip RED only for**: pure interfaces/types, constants/enums, type-only fixes (caught by `tsc`).

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

## Adding a new file

`src/X.ts` → `tests/X.test.ts` → export from `src/index.ts` → `npm run all`

For test patterns (mocks, branch coverage, isolated filesystem), see `TESTING.md`.
