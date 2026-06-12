# Task Orchestrator

Autonomous task execution engine. Spawns AI agents to complete tasks defined in markdown files, measures progress via benchmarks, and merges when acceptance criteria are met.

```bash
orchestrator add "fix-auth" --goal "Fix auth timeout" --metric "pass_count"
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
orchestrator add "my-task" --goal "Make tests pass" --metric "failures"
npm run tick
```

## How it works

1. Define a task in `tasks/pending/<name>/autoresearch.md`
2. Run orchestrator → picks task, runs benchmark, spawns AI agent
3. Agent iterates in isolated git worktree
4. Task merges when benchmark reports all metrics = 0 for 3 consecutive runs

## Core concepts

**Acceptance criteria:** Task owns a `benchmark.js` that outputs `METRIC name=value` lines. All metrics must be `0` to pass. See `docs/DOC_AUTHORING.md` for details.

**Convergence:** When all metrics reach 0 for 3 consecutive runs (configurable), task is marked ready to merge.

**Merge guards:** Before merge, benchmark runs again after syncing with base branch. Optional `ORCH_VERIFY_CMD` (e.g., `npm run tc`) can block merge. Conflicts keep worktree for inspection.

**Multi-orchestrator safe:** File-based coordination via atomic claims and heartbeat monitoring. See `docs/DEVELOP.md` for details.

**Loop mode (infinite mode):** Run with `--infinite` or `ORCH_INFINITE=1` to keep the orchestrator alive indefinitely. It will continuously poll for new tasks and wait for blocked/failed tasks to be addressed. Polling interval is configurable via `ORCH_IDLE_SLEEP_MS` (default: 5000ms). Exit with `--stop` or Ctrl+C.

**Atomic task claiming:** When running with `--parallel > 1`, task claiming is atomic: only one orchestrator process can claim a task at a time, preventing race conditions. Lock files (`.claim.lock`) are created with exclusive write and cleaned up after task completion. This enables safe concurrent execution across multiple machines.

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

## Fleet orchestration

Run multiple orchestrators concurrently on the same task queue for high-throughput unattended execution:

```bash
# On machine 1: wait indefinitely for new tasks, run 2 in parallel
ORCH_PARALLEL=2 ORCH_INFINITE=1 orchestrator

# On machine 2: same setup (both machines share the task queue)
ORCH_PARALLEL=2 ORCH_INFINITE=1 orchestrator

# On machine 3: add new task dynamically
orchestrator add "new-task" --goal "Do something"

# Stop all orchestrators
orchestrator --stop
```

All instances coordinate safely via:
- **Atomic claiming:** Only one process claims each task (`.claim.lock` file with exclusive write)
- **Heartbeat monitoring:** Fresh heartbeat prevents stale claim reclamation across machines
- **Stale claim recovery:** Dead processes' claims are released after configurable timeout (default: 30 min)

## Configuration

Set via CLI flags, environment variables, or defaults. See `docs/ENV_VARS.md` for all options.

**Most important:**
- `--state-root` / `ORCH_STATE_ROOT` — where tasks/worktrees live (default: `$HOME/task-orchestrator`)
- `--agent` / `ORCH_AGENT` — coding agent: `pi` (default) or `copilot`
- `--model` / `ORCH_MODEL` — model override (e.g., `gpt-5`, `claude-opus`)
- `--parallel` / `ORCH_PARALLEL` — max concurrent tasks (default: 1, serial; 0=unlimited)

Use `orchestrator --config` to inspect effective values and their sources.

## Task structure

```
tasks/pending/T01-my-task/
├── autoresearch.md   # Goal, metric, scope
├── autoresearch.sh   # Auto-generated runner
└── benchmark.js      # Outputs: METRIC name=value (sum must be 0)
```

Task metadata in `autoresearch.md`: `**Model:**`, `**Reasoning:**`, `**Retry limit:**`. See `docs/DEVELOP.md` for details.

## Development

See `docs/DEVELOP.md` for TDD workflow, SOLID principles, and code conventions. See `docs/TESTING.md` for test conventions.

```bash
npm run c      # type-check
npm run t      # run tests
npm run tc     # tests + coverage
npm run all    # lint + type-check + tests + build
```
