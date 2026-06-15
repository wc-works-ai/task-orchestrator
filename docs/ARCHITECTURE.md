# Architecture

`src/` is grouped into four shallow domain folders, with the two entry points at
the root. Tests are tiered by *type* (`tests/{unit,integration,e2e}/`), which is
orthogonal to these domains — they do not mirror each other.

```
src/
  cli.ts        executable entry — parses args, wires the Engine, runs the loop
  index.ts      library barrel — public exports
  shared/       base utilities (no deps on other domains)
  state/        task state + persistence
  agent/        coding-agent abstraction + implementations
  engine/       the orchestration loop + git
```

## Dependency direction

```
cli → engine → { agent, state } → shared
```

Lower layers never import higher ones. `shared/` is the base; `cli.ts` sits on top.

## Domains

**shared/** — cross-cutting infrastructure
- `errors` — severity-based error types + `withRetry`
- `env` — env-var getters · `config` — `CONFIG_SPEC` for `--config`/help
- `metrics` — parse `METRIC name=value` lines · `BenchmarkMeta` — benchmark metadata

**state/** — task state, stored in SQLite (`tasks/state.db`), content on disk
- `sqlite` — thin `node:sqlite` wrapper (WAL) · `TaskDb` — schema + atomic ops
- `TaskState` — DB-backed per-task view · `Status` — status enum
- `addTask` — task creation · `migrate` — import legacy file-shard tasks
- `StatePaths` — resolve tasks/worktrees roots

**agent/** — how work gets done in a worktree
- `CodingAgent` — interface + shared helpers · `agents` — registry
- `PiAgent` + `PiCommand` — pi · `CopilotAgent` — copilot · `ExecAgent` — deterministic command agent
- `AgentLog` — per-run logs · `Prerequisites` — preflight checks

**engine/** — orchestration
- `Engine` — the tick loop (pick → benchmark → converge/fail → merge), recovery, reconciliation
- `Worktree` — git worktree create/sync/merge · `TaskGraph` — dependency DAG render
- `RunReport` — `--status` dashboard

## Entry points

- **`cli.ts`** — the executable (`tsx src/cli.ts`, built to `dist/cli.js`, run via `bin.mjs`).
- **`index.ts`** — the library barrel (`dist/index.js`); the package `main`.

Both stay at the `src/` root so package scripts, `bin.mjs`, and the e2e harness
spawn are layout-independent.
