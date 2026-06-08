# AGENTS.md

> **⚠️ REQUIRED READING BEFORE ANY CODE CHANGE**
> 1. **`DEVELOP.md`** — TDD + SOLID workflow, branch mapping, code review checklist
> 2. **`TESTING.md`** — test conventions, mock rules, coverage targets
> 3. **`AGENTS.md`** — behavioral guidelines (this file)
>
> Run `npm run c && npm run t` before every commit. Violating DEVELOP.md or TESTING.md is a defect.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

Strong success criteria let you loop independently.

---

## Task Orchestrator Repo Guidance

This is a **library-first** TypeScript repo. Tests are the source of truth.

### Commands (single-letter — memorize these)
```
npm run c     tsc --noEmit           type-check
npm run t     vitest run             run tests
npm run tc    vitest run --coverage  test + coverage
npm run tw    vitest                 watch mode
npm run all   c + t + b             full pipeline
npm run stat  --status              show dashboard

### Environment variables (CLI flags override)
| Variable | Default | Controls |
|---|---|---|
| `ORCH_TASKS` | `./tasks` | Task directory |
| `ORCH_REPO` | auto-detect | Git repo root |
| `ORCH_MODEL` | `openrouter/owl-alpha` | Default AI model |
| `ORCH_CONVERGE` | `3` | Zero-runs to converge |
| `ORCH_MAX_FAILURES` | `5` | Failures before BLOCKED |
| `ORCH_WORKTREES` | `<repo>/.worktrees` | Git worktrees location |
| `ORCH_HEARTBEAT_MS` | `300000` | Stale claim timeout |
```

### Code conventions
- **TypeScript strict** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`
- **Private fields** — `#name` for encapsulation, never `private name`
- **Imports** — `import type` for type-only imports, `verbatimModuleSyntax`
- **Files** — one class per file, barrel exports in `index.ts`
- **Tests** — see `TESTING.md` for conventions

### Adding new tasks
Use the same API — CLI and agents produce identical output:
```bash
orchestrator add <name>                         # scaffold with TODOs
orchestrator add <name> --goal ... --metric ...  # with details
```
Agents should use the CLI: `execSync('orchestrator add <name>')` for consistency.

### Architecture
```
src/
  Status.ts       enums + constants (pure, no I/O)
  TaskState.ts    filesystem state (status, claims, convergence)
  Engine.ts       main loop (tick + loop + recovery)
  index.ts        barrel exports
tests/
  TaskState.test.ts
  Engine.test.ts
orchestrator.mjs  CLI entry point
```

### Before committing
1. `npm run c` — zero type errors (fast: ~2s)
2. `npm run t` — all tests pass (fast: ~3s)
3. `npm run all` — full pipeline (pre-push hook enforces this)
   Dev cycle: `c + t` for quick feedback; `all` only on push
