# Developing for Task Orchestrator

This repo follows **TDD** (test-driven development) and **SOLID** principles. Read `TESTING.md` first for test conventions — this doc builds on that.

---

## TDD Cycle

Every change follows **Red → Green → Refactor**:

```
1. RED   — Write the test first. Watch it fail:  npm run t
2. GREEN — Write the minimum code to pass:       npm run t
3. REFAC — Clean up without breaking tests:      npm run all
```

### When to skip RED

Only skip writing the test first when:
- Adding a pure interface/type definition (no runtime behavior)
- Adding a constant or enum (tested implicitly by consumers)
- Fixing a type error that `tsc --noEmit` catches

Every runtime behavior change gets a test first.

---

## Mapping TDD to this repo

### 1. Read the source. Map every branch.

Before writing a test, read the source file and identify:
- **Happy path** — the main flow
- **Edge cases** — empty state, boundary values, null/undefined
- **Error paths** — every `try/catch`, every guard clause (`if` that returns/throws), every `continue`

Example: for `TaskState.pick()`, the branches are:
- Shard iteration order: `pending` → `in_progress` → `failed`
- Per-task: converged skip, blocked skip, failed+max_failures→blocked, in_progress + unclaimed → release, in_progress + our claim → return, actionable + claimable → return
- `dependenciesMet()` false → skip

Each branch gets a test case.

### 2. Write tests in `tests/{Module}.test.ts`

One test file per source file. Group by method:

```ts
describe('TaskState', () => {
  describe('pick', () => {
    it('returns pending task in numeric order', ...);
    it('skips converged tasks', ...);
    it('releases unclaimed in-progress tasks to FAILED', ...);
    it('returns our own in-progress claim', ...);
    it('skips tasks with unmet dependencies', ...);
    it('marks task BLOCKED after max failures', ...);
  });
});
```

### 3. Use `vi.mock` at module boundaries

Mock external modules (`child_process`, `fs`), never mock internals. Use `mkdtempSync` for real filesystem isolation:

```ts
const dir = mkdtempSync(resolve('/tmp', 'test-'));
// ... create task directory with writeFileSync ...
const t = new TaskState(resolve(dir, 'pending', 'T01-task'));
```

### 4. Verify coverage after each cycle

```bash
npm run tc     # vitest run --coverage
```

Target each file's branch coverage independently. The `--coverage` reporter shows uncovered line numbers.

---

## SOLID Principles

Applied concretely to this codebase:

### S — Single Responsibility

Each class does one thing:

| File | Responsibility |
|---|---|
| `Status.ts` | Enum definitions, pure helpers — no I/O |
| `TaskState.ts` | Filesystem state management — status, claims, convergence |
| `Engine.ts` | Orchestration loop — tick, recovery, spawn coordination |
| `Worktree.ts` | Git worktree lifecycle — create, merge, remove |
| `PiSpawner.ts` | Process spawning — child process lifecycle, logging |
| `Prerequisites.ts` | Environment checks — Node version, pi CLI, API key |

If a method does two things, split it. Example: `Engine.tick()` picks a task AND runs benchmarks AND spawns agents. These are three sequential responsibilities — refactoring into `#runBenchmark()` and `#runSpawn()` is correct.

### O — Open for Extension, Closed for Modification

Depend on interfaces, not concretions:

```ts
// Engine depends on abstractions
export type SpawnFn = (task: TaskState, worktreePath?: string, signal?: AbortSignal) => Promise<SpawnResult>;
export type BenchmarkFn = (task: TaskInfo) => Promise<number> | number;

class Engine {
  readonly #spawn: SpawnFn | null;
  readonly #bench: BenchmarkFn;
}
```

New behavior (e.g., Docker-based spawning) doesn't modify `Engine` — it provides a new `SpawnFn`.

### L — Liskov Substitution

Subtypes must be substitutable for their base types. In TypeScript, this means:
- **Function signatures** — callback parameters are contravariant. `(task: TaskState) => void` is NOT a subtype of `(task: TaskInfo) => void`.
- **Return types** — covariant. A function returning `TaskState` can substitute one returning `TaskInfo` (since `TaskState` satisfies `TaskInfo`).
- **Never widen types** in overrides. If the interface says `string?`, don't make it required in an implementation.

### I — Interface Segregation

Keep interfaces small and focused:

```ts
// GOOD: small, focused
export interface TaskInfo {
  readonly directory: string;
  readonly number: number;
  readonly name: string;
  readonly goal: string;
  readonly model: string;
  readonly status: string;
}

// AVOID: one large interface with optional fields
// AVOID: passing entire TaskState when TaskInfo suffices
```

When a consumer only needs `directory` and `number`, accept `Pick<TaskInfo, 'directory' | 'number'>` or a dedicated small type.

### D — Dependency Inversion

High-level modules (`Engine`) should not depend on low-level modules (`PiSpawner`, `Worktree`). Both should depend on abstractions:

```ts
// Engine depends on SpawnFn (abstraction), not PiSpawner (concretion)
class Engine {
  constructor(opts: { spawn?: SpawnFn }) { ... }
}

// cli.ts wires them together
const spawner = new PiSpawner();
new Engine(dir, { spawn: (t, wt, sig) => spawner.spawn(t, wt, sig) });
```

This makes `Engine` testable without spawning real processes — pass a mock `SpawnFn`.

---

## Code Review Checklist

Before every commit (`git add -A && git commit`):

### TDD
- [ ] Did you write the test before the code? (RED → GREEN)
- [ ] Does every branch in the source have a corresponding test case?
- [ ] Does `npm run tc` show 100% branch coverage for changed files?

### SOLID
- [ ] Does each class have one responsibility?
- [ ] Are dependencies injected (via constructor or function parameters), not hard-coded?
- [ ] Are interfaces small and focused?
- [ ] Does `Engine` depend on abstractions (`SpawnFn`, `BenchmarkFn`), not concretions?

### TypeScript
- [ ] `npm run c` — zero type errors
- [ ] `import type` for type-only imports (`verbatimModuleSyntax`)
- [ ] `#privateField` not `private fieldName`
- [ ] `noUncheckedIndexedAccess` — array access uses `[i] ?? fallback`
- [ ] `exactOptionalPropertyTypes` — no `undefined` where option expects omission

### Tests
- [ ] Isolated filesystem (`mkdtempSync`), no real files
- [ ] Mock at module boundary (`vi.mock('node:child_process')`)
- [ ] Happy path + edge case + error path for every public method
- [ ] Verify: `npm run all` — full pipeline green

---

## Common Patterns

### Branch coverage for guard clauses

```ts
// Source
get status(): Status {
  try {
    const raw = readFileSync(...).trim();
    return (raw || Status.PENDING) as Status;
  } catch { return Status.PENDING; }
}

// Tests
it('reads status from file', ...);   // happy path
it('returns PENDING for missing file', ...);  // catch branch
it('returns PENDING for empty file', ...);    // raw || PENDING branch
```

### Testing callbacks passed to Engine

```ts
const mockSpawn = vi.fn<(...args: any[]) => any>().mockResolvedValue({ success: true, iterations: 3 });
const engine = new Engine(dir, { spawn: mockSpawn, benchmark: () => 1 });
await engine.tick();
expect(mockSpawn).toHaveBeenCalledWith(
  expect.objectContaining({ taskNumber: 1 }),
  expect.any(String),
  expect.any(AbortSignal),
);
```

### Adding a new source file

1. Create `src/{Module}.ts` — one class/export, no side effects
2. Create `tests/{Module}.test.ts` — mirror structure, full branch coverage
3. Export from `src/index.ts` if part of the public API
4. `npm run all` — green
