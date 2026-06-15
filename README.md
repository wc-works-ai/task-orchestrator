# Task Orchestrator

Autonomous task execution engine. Spawns AI agents to complete tasks defined in markdown files, measures progress via benchmarks, and merges when acceptance criteria are met.

```bash
orchestrator add "fix-auth" --repo /path/to/repo --goal "Fix auth timeout" --metric "pass_count"
orchestrator              # run one task cycle
orchestrator --loop       # daemon mode
orchestrator --status     # show dashboard
```

## Install

```bash
git clone https://github.com/wc-works-ai/task-orchestrator.git
cd task-orchestrator
npm install
git config core.hooksPath .githooks
```

Requires Node.js >= 22 and a configured coding agent CLI.

## Quick start

```bash
orchestrator add "my-task" --repo . --goal "Make tests pass" --metric "failures"
npm run tick
```

## How it works

1. Create a task with `orchestrator add --repo <path>` — state is recorded in the global `<state-root>/tasks/state.db`; content lands in `<state-root>/tasks/T01-<name>/`
2. Run orchestrator → drains the global queue, resolving each task's repo
3. Agent iterates in an isolated git worktree for that task's repo
   - Spawned agent prompts instruct agents to read worktree-local guidance (`AGENTS.md`, `docs/DEVELOP.md`, `docs/TESTING.md`) and follow local environment/tooling policy.
4. Task merges when benchmark reports all metrics = 0 for 3 consecutive runs

## Core concepts

**Acceptance criteria:** Task owns a `benchmark.js` that outputs `METRIC name=value` lines. All metrics must be `0` to pass. See `docs/DOC_AUTHORING.md` for details.

**Convergence:** When all metrics reach 0 for 3 consecutive runs (configurable), task is marked ready to merge.

**Merge guards:** Before merge, benchmark runs again after syncing with base branch. Optional `ORCH_VERIFY_CMD` (e.g., `npm run tc`) can block merge. Conflicts keep worktree for inspection.

**Metric hygiene:** Keep benchmark metric names task-specific (for example `review_report_gap`, not generic `branch_gap`) so live logs stay unambiguous. If needed, adopt strict expected-metric filtering from task metadata as a follow-up hardening option.

**State storage:** Task state (status, convergence, failures, claims, dependencies, repo) lives in one global SQLite database, `<state-root>/tasks/state.db`. The filesystem holds task content under `<state-root>/tasks/` and worktrees under `<state-root>/worktrees/`.

**Concurrent-safe (single machine):** Multiple worker processes on one host coordinate through the shared `state.db` — atomic claims (one claimant per task) plus heartbeat-based recovery of crashed workers. SQLite WAL requires all processes on the same machine.

**Loop mode (infinite mode):** Run with `--infinite` or `ORCH_INFINITE=1` to keep the orchestrator alive indefinitely. It will continuously poll for new tasks and wait for blocked/failed tasks to be addressed. Polling interval is configurable via `ORCH_IDLE_SLEEP_MS` (default: 5000ms). Exit with `--stop` or Ctrl+C.

**Atomic task claiming:** With `--parallel > 1` (or several processes), each task is claimed by exactly one worker via an atomic database update carrying a per-claim token, preventing races.

## Key CLI commands

```bash
orchestrator --once           # Single cycle
orchestrator --status         # Dashboard
orchestrator --config         # Show resolved config
orchestrator --check          # Validate prerequisites
orchestrator edit <n>         # Edit task metadata
orchestrator --infinite       # Daemon: wait for new tasks until --stop
orchestrator --parallel 2     # Run up to 2 tasks concurrently
```

Full CLI reference: `orchestrator --help` or `docs/DEVELOP.md`.
Documentation entrypoint: `docs/INDEX.md`.

## Parallel execution

Run several workers on one machine for high-throughput unattended execution. They share the global `<state-root>/tasks/state.db` and coordinate automatically:

```bash
# Run up to 2 tasks concurrently, waiting indefinitely for new ones
ORCH_PARALLEL=2 ORCH_INFINITE=1 orchestrator

# Add a task dynamically (from another shell)
orchestrator add "new-task" --repo /path/to/repo --goal "Do something"

# Stop the orchestrator
orchestrator --stop
```

Coordination is via:
- **Atomic claiming:** each task is claimed by one worker via a single DB update (per-claim token)
- **Heartbeat recovery:** a claim whose heartbeat goes stale (crashed worker) is reclaimed; convergence progress is preserved
- **Merge lock:** concurrent merges to the same task repo are serialized

> Single machine only — SQLite WAL does not support sharing `state.db` across hosts.

## Configuration

Set via CLI flags, environment variables, or defaults. See `docs/ENV_VARS.md` for all options.

**Most important:**
- `--state-root` / `ORCH_STATE_ROOT` — where tasks/worktrees live (default: `$HOME/task-orchestrator`)
- `--repo` / `ORCH_REPO` — repo bound to new tasks by `add`
- `--agent` / `ORCH_AGENT` — coding agent: `pi` (default) or `copilot`
- `--model` / `ORCH_MODEL` — model override (e.g., `gpt-5`, `claude-opus`)
- `--parallel` / `ORCH_PARALLEL` — max concurrent tasks (default: 1, serial; 0=unlimited)

Use `orchestrator --config` to inspect effective values and their sources.

## Task structure

```
tasks/
├── state.db            # SQLite: status, convergence, claims, dependencies
└── T01-my-task/
    ├── autoresearch.md # Goal, metric, scope
    └── benchmark.js    # Outputs: METRIC name=value (sum must be 0)
```

Task metadata in `autoresearch.md`: `**Model:**`, `**Reasoning:**` (read live per run). The retry limit is fixed at creation from `ORCH_MAX_FAILURES`. See `docs/DEVELOP.md` for details.

Clean cutover: upgrading from the old per-repo layout starts a fresh global queue; old `<state-root>/<slug>/tasks` DBs are not auto-imported.

## Development

See `docs/DEVELOP.md` for TDD workflow, SOLID principles, and code conventions. See `docs/TESTING.md` for test conventions.

```bash
npm run c      # type-check
npm run t      # run tests
npm run tc     # tests + coverage
npm run all    # lint + type-check + tests + build
```
