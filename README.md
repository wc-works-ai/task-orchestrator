# Task Orchestrator

Autonomous task execution engine. Spawns AI agents to complete tasks defined in markdown files, measures progress via benchmarks, and converges tasks when acceptance criteria are met.

```
$ orchestrator add "fix-auth-bug" --goal "Fix authentication timeout" --metric "pass_count" --scope "src/auth.ts tests/auth.test.ts"
$ orchestrator               # run one task
$ orchestrator --loop         # daemon mode: wait forever until --stop
$ orchestrator --status       # show dashboard
```

## Install

```bash
git clone https://github.com/wc-works-ai/task-orchestrator.git
cd task-orchestrator
npm install
git config core.hooksPath .githooks   # enable pre-commit + pre-push hooks
```

Requires Node.js >= 22 and a configured coding agent CLI.

## Quick start

```bash
# Create a task
orchestrator add "hello-world" --goal "Make all tests pass" --metric "failures"

# Edit the task's autoresearch.md with details, then run
npm run tick
```

## How it works

1. **Define a task** in `<state-root>/<repo-slug>/tasks/pending/<name>/autoresearch.md`
2. **Run orchestrator** — picks task, runs benchmark, spawns AI agent
3. **Agent iterates** — runs experiments in isolated git worktree
4. **Convergence** — when every metric reaches 0 for 3 consecutive runs, task is merged

## Acceptance Criteria

**Benchmark decides pass/fail:**
- Each task owns a `benchmark.js` that prints `METRIC name=value` lines.
- **Every metric must be `0`** for the task to pass.

```js
console.log('METRIC failing_tests=0');
console.log('METRIC lint_errors=0');
```

**Convergence & merge guards:**
- Task must pass benchmark for `ORCH_CONVERGE` consecutive runs (default: 3).
- Any non-zero metric resets convergence → agent runs again.
- If merge conflicts occur, task is marked BLOCKED and worktree kept for inspection.
- Before merge: benchmark runs again after syncing with base branch.
- Optional `ORCH_VERIFY_CMD` can block merge (e.g., enforce coverage).

**Merge happens last:**
- Only after all metrics are 0, convergence satisfied, post-sync re-verify passes, and optional `ORCH_VERIFY_CMD` passes.

## CLI

| Command | Description |
|---|---|
| `orchestrator` | Run current repo until all tasks complete |
| `orchestrator --once` | Process one tick and exit |
| `orchestrator --status` | Show task dashboard |
| `orchestrator --config` | Print resolved configuration and paths |
| `orchestrator --check` | Check prerequisites |
| `orchestrator --stop` | Signal running instances to stop |
| `orchestrator --task <n>` | Force-pick specific task |
| `orchestrator --auto-stash` | Stash parent repo changes before merging |
| `orchestrator --keep-alive` | Keep looping through transient idle/cooldown periods |
| `orchestrator --infinite` / `--loop` | Never exit on idle; wait for new or addressed tasks until `--stop` |
| `orchestrator --agent <name>` | Coding agent: `pi` (default) or `copilot` |
| `orchestrator --model <model>` | Model override passed to the coding agent |
| `orchestrator --reasoning <level>` | Reasoning effort override for supported agents |
| `orchestrator add <name>` | Scaffold a new task |
| `orchestrator edit <n>` | Edit task metadata |

### Inspect configuration

- `orchestrator --config` prints the **effective** configuration: each resolved value, its source (`flag`, `env`, or `default`), and resolved paths. Use it before a long run to verify env vars and flags took effect.
- `orchestrator --check` validates prerequisites and agent auth, such as `COPILOT_GITHUB_TOKEN` / `GITHUB_TOKEN` for copilot or `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` for pi.

By default, tasks and worktrees are stored together under the state root:

```text
<state-root>\<repo-slug>\tasks
<state-root>\<repo-slug>\worktrees
```

The default state root is `<home>\task-orchestrator`.

Explicit `--tasks` and `--worktrees` paths override those derived locations.

## Environment variables

Resolution order: CLI flag > env var > default.

Boolean env vars accept `1`, `true`, `yes`, or `on`.

### Paths

| Variable | CLI flag | Default | Description |
|---|---|---|---|
| `ORCH_REPO` | `--repo` | current directory | Target repo/folder |
| `ORCH_STATE_ROOT` | `--state-root` | `<home>\task-orchestrator` | Orchestrator state root |
| `ORCH_TASKS` | `--tasks` | `<state-root>\<repo-slug>\tasks` | Task directory |
| `ORCH_WORKTREES` | `--worktrees` | `<state-root>\<repo-slug>\worktrees` | Worktree directory |

### Coding agent

| Variable | CLI flag | Default | Description |
|---|---|---|---|
| `ORCH_AGENT` | `--agent` | `pi` | Coding agent: pi or copilot |
| `ORCH_MODEL` | `--model` | agent default | Model override passed to the agent |
| `ORCH_REASONING` | `--reasoning` | unset | Reasoning effort for supported agents |

### Run mode

| Variable | CLI flag | Default | Description |
|---|---|---|---|
| `ORCH_KEEP_ALIVE` | `--keep-alive` | off | Wait through transient idle/cooldown periods |
| `ORCH_INFINITE` | `--infinite`, `--loop` | off | Daemon mode; wait for new/addressed tasks |
| `ORCH_IDLE_SLEEP_MS` | env only | `5000` | Idle poll interval for keep-alive/infinite (ms) |

### Convergence & merge

| Variable | CLI flag | Default | Description |
|---|---|---|---|
| `ORCH_CONVERGE` | env only | `3` | Zero-metric runs required to converge |
| `ORCH_MAX_FAILURES` | env only | `5` | Failed attempts before BLOCKED (int>=1 or `infinite`) |
| `ORCH_AUTO_STASH` | `--auto-stash` | off | Stash parent repo changes before merging |
| `ORCH_MERGE_LOCK_MS` | env only | `600000` | Break a merge lock held longer than this (crashed merger, ms) |
| `ORCH_VERIFY_CMD` | env only | unset | Shell command to run in worktree before merge (e.g. `npm run tc`) |

### Concurrency & timeouts

| Variable | CLI flag | Default | Description |
|---|---|---|---|
| `ORCH_HEARTBEAT_MS` | env only | `300000` | Claim heartbeat freshness window (ms) |
| `ORCH_CLAIM_MAX_MS` | env only | `1800000` | Hard claim ceiling; reclaim stale claim even across machines (ms) |
| `ORCH_PROGRESS_TIMEOUT` | env only | `120000` | Kill agent after no output for this long (ms) |

### Logging

| Variable | CLI flag | Default | Description |
|---|---|---|---|
| `ORCH_LOG_LEVEL` | env only | `normal` | Console verbosity: quiet \| normal \| verbose |
| `ORCH_AGENT_LOG_RAW` | env only | off | Write raw spawned-agent output to agent.log |
| `ORCH_AGENT_LOG_MAX_BYTES` | env only | `10485760` | Max agent.log size before truncation (bytes) |

## Task structure

```
tasks/pending/T01-my-task/
├── autoresearch.md   # Goal, metric, scope, acceptance criteria
├── autoresearch.sh   # Auto-generated experiment runner
└── benchmark.js      # Outputs: METRIC <name>=<value> (all must be 0)
```

A benchmark may print **multiple** `METRIC` lines. The effective metric is the **sum** of all values. A benchmark with no `METRIC` line is treated as metric `1` (not done).

**Optional autoresearch.md metadata:**
| Field | Controls |
|---|---|
| `**Model:**` | Task-level model override |
| `**Reasoning:**` | Task-level reasoning override |
| `**Retry limit:**` | Failed attempts before BLOCKED |

Dependencies wait for all referenced tasks to converge; if any is terminally BLOCKED, dependents auto-BLOCKED.

## Merging converged work

When a task converges:
1. **Update before merge** — latest base is merged into the task branch to absorb sibling changes
2. **Re-verify acceptance** — benchmark runs again after absorbing base; if broken, send back to agent
3. **Serialize merges** — one orchestrator merges at a time (atomic `mkdir`); stale merge locks are broken
4. **Park, never discard** — genuine conflicts block the merge and keep the worktree for inspection

## Running multiple orchestrators

Several orchestrators can safely share one task directory and repo via file-based coordination:

- **Atomic claim** — picking a task creates `.claim` directory (atomic `mkdir`); only one wins; loser moves on
- **Liveness by heartbeat** — owner refreshes heartbeat file; others only judge by heartbeat age, never by pid
- **Recovery** — reclaim stale claim if: (a) owner on this machine and pid gone, or (b) claim older than `ORCH_CLAIM_MAX_MS`
- **Unique identity** — each orchestrator gets globally-unique instance id (`<pid>-<random>`)

## Coding agents

- `pi` (default) — uses pi's experiment tools; accepts `--model` / `ORCH_MODEL`
- `copilot` — GitHub Copilot CLI with `copilot -p "<prompt>" -s --allow-all-tools --no-ask-user [--model <model>] [--reasoning-effort <level>]`
  - Requires: `copilot` CLI + `COPILOT_GITHUB_TOKEN` (or gh/GITHUB_TOKEN)
  - Limitation: doesn't report token usage; uses shell benchmark loop

**Adding a new agent:**
1. Create `src/<Name>Agent.ts` implementing `CodingAgent`
2. Register in `src/agents.ts` `REGISTRY`
3. Run `npm run all` — no Engine.ts changes needed

## Development

See `docs/DEVELOP.md` for TDD workflow, SOLID principles, and code conventions. See `docs/TESTING.md` for test conventions.

```bash
npm run c      # type-check
npm run t      # run tests
npm run tc     # tests + coverage
npm run all    # lint + type-check + tests + build
```
