# Environment Variables

Resolution order: CLI flag > env var > default.

Run `orchestrator --config` to inspect effective values.

## Variables

### Paths

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `ORCH_REPO` | `--repo` | cwd | Target repository |
| `ORCH_STATE_ROOT` | `--state-root` | `$HOME/task-orchestrator` | Tasks and worktrees root |
| `ORCH_TASKS` | `--tasks` | `<state-root>/<repo-slug>/tasks` | Task directory |
| `ORCH_WORKTREES` | `--worktrees` | `<state-root>/<repo-slug>/worktrees` | Worktree directory |

### Agent

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `ORCH_AGENT` | `--agent` | `pi` | Agent: `pi` or `copilot` |
| `ORCH_MODEL` | `--model` | agent default | Model override |
| `ORCH_REASONING` | `--reasoning` | unset | Reasoning effort |

### Run Mode

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `ORCH_KEEP_ALIVE` | `--keep-alive` | off | Keep looping through idle |
| `ORCH_INFINITE` | `--loop` | off | Daemon mode: never exit |
| `ORCH_IDLE_SLEEP_MS` | — | `5000` | Poll interval when idle (ms) |
| `ORCH_PARALLEL` | `--parallel` | `1` | Max concurrent tasks (0=unlimited) |

### Convergence & Merge

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `ORCH_CONVERGE` | — | `3` | Consecutive zero-metric runs to converge |
| `ORCH_KEEP_CONVERGED` | `--keep-converged` | `100` | Max retained converged dirs (0=unlimited) |
| `ORCH_MAX_FAILURES` | — | `5` | Attempts before BLOCKED (`infinite` for unlimited) |
| `ORCH_AUTO_STASH` | `--auto-stash` | `true` | Stash parent repo before merge |
| `ORCH_MERGE_LOCK_MS` | — | `600000` | Break stale merge lock after (ms) |
| `ORCH_VERIFY_CMD` | — | unset | Shell command to run before merge |

### Timeouts

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `ORCH_HEARTBEAT_MS` | — | `300000` | Reclaim a claim whose heartbeat is older than this (crashed worker, ms) |
| `ORCH_PROGRESS_TIMEOUT` | — | `120000` | Kill silent agent after (ms) |
| `ORCH_BENCHMARK_TIMEOUT` | — | `120000` | Kill benchmark after (ms) |

### Logging

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `ORCH_LOG_LEVEL` | — | `normal` | `quiet`, `normal`, or `verbose` |
| `ORCH_AGENT_LOG_RAW` | — | off | Raw verbatim agent stream instead of the default structured, timestamped activity log |
| `ORCH_AGENT_LOG_MAX_BYTES` | — | `10485760` | Max per-run log size (bytes) |

## Notes

- Booleans accept: `1`, `true`, `yes`, `on` (case-insensitive). `ORCH_AUTO_STASH` defaults to `true` — set `false` to disable.
- Millisecond values: 1000 = 1s. Defaults are production-tested.
- Parallel: `ORCH_PARALLEL=0` = unlimited (clamped to 100). Default 1 = serial.
- Paths: `ORCH_TASKS`/`ORCH_WORKTREES` auto-derived from `ORCH_STATE_ROOT` if not set.
- Pruning: content dirs of converged tasks exceeding `ORCH_KEEP_CONVERGED` are deleted; the DB rows remain (the converged count is preserved).
- CLI flags override env vars. Set permanent config in `~/.bashrc`; use flags for one-off overrides.
- Agent logs: each run writes a timestamped `agent-<time>.log` with one line per activity — for `pi`, LLM turns (with token usage), tool calls, and text parsed from its JSON stream; for `copilot`/`exec`, timestamped output lines. `ORCH_AGENT_LOG_RAW=1` switches to the unprocessed stream for debugging.
