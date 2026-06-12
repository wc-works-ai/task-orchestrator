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

1. **Define a task** in `<state-root>/<repo-slug>/tasks/pending/<name>/autoresearch.md` with goal, metric, scope, and acceptance criteria
2. **Run the orchestrator** — it picks the highest-priority task, runs the benchmark, and spawns an AI agent
3. **Agent iterates** — reads the task, runs experiments, edits files in an isolated git worktree
4. **Convergence** — when every metric reaches 0 for 3 consecutive runs, the task is merged back

If merge-back is blocked, the task is marked BLOCKED and the worktree is kept for inspection while the run continues. Interactive runs may auto-stash parent repo changes and retry the merge immediately.

Agent summaries include total token usage when the spawned agent reports usage data. `agent.log` is summary-only by default for `pi`; set `ORCH_AGENT_LOG_RAW=1` to also write raw spawned-agent stdout/stderr. Raw logs are capped at 10 MiB by default and keep the latest output when truncated.

Long loop runs print an `Overview:` counts line after each tick and a final `Summary:` with one icon-prefixed line per task.
Infinite/daemon mode (`--infinite`, `--loop`, or `ORCH_INFINITE`) never exits on idle. It polls every `ORCH_IDLE_SLEEP_MS` for new tasks or for BLOCKED/FAILED tasks to be addressed; stop it with `orchestrator --stop`.

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
└── benchmark.js      # Measures metric, outputs "METRIC <name>=<value>"
```

A benchmark may print **multiple** `METRIC <name>=<value>` lines. The effective metric is the **sum** of all values, so a task converges only when **every** criterion is 0. Unmet criteria are listed in the console (`T<n> unmet: ...`). A benchmark that prints no METRIC line is treated as metric `1` (not done).

Optional `autoresearch.md` metadata:

| Field | Values | Controls |
|---|---|---|
| `**Model:**` | agent-specific model name | Task-level model override; falls back to `--model` / `ORCH_MODEL` |
| `**Reasoning:**` | agent-specific effort level | Task-level reasoning override; falls back to `--reasoning` / `ORCH_REASONING` |
| `**Retry limit:**` | integer >= 1, `infinite`, `unlimited`, or `inf` | Failed attempts before BLOCKED; falls back to `ORCH_MAX_FAILURES` |

Dependencies wait for all referenced tasks to converge; if any dependency is terminally BLOCKED, dependents are automatically BLOCKED transitively, while still-retrying FAILED dependencies keep dependents waiting.

### Task-agnostic (environment) failures

A *task-agnostic* failure would hit every task the same way: the coding agent's environment is misconfigured or unavailable (for example, a missing or invalid API key). The orchestrator **fails fast**: on the first such failure it stops the whole run immediately, in every mode including `--infinite`.

The affected task is left `FAILED` **without** consuming a retry. The CLI prints `Environment issue: <reason>` and exits non-zero, so operators or automation can fix the environment and rerun. Remaining pending tasks are not picked, which prevents one environment problem from churning every task into `FAILED`.

A *task-specific* failure is different: the agent ran but the metric is still non-zero, or a merge conflict occurred. These failures consume the task's retry budget as usual.

## Merging converged work

When a task converges, its branch is merged back to the base with a layered, deterministic strategy — the orchestrator never auto-edits file contents:

1. **Update before merge.** The latest base is first merged *into* the task branch (`syncWithBase`). This absorbs a base that advanced while the agent worked (e.g. a sibling task merged), so only genuinely overlapping edits remain a conflict.
2. **Re-verify acceptance.** After absorbing the base, the benchmark runs again. If the base advance broke any criterion, the task is sent back to the agent (its convergence count resets) rather than merging broken work.
3. **Serialize merges.** A repo-scoped merge lock (atomic `mkdir`, the same primitive as task claims) lets only one orchestrator merge into the shared base at a time. If the lock is held, the merge is deferred to the next tick; a lock left by a crashed merger (older than `ORCH_MERGE_LOCK_MS`) is broken.
4. **Park, never discard.** A genuine overlapping conflict marks the task BLOCKED and keeps its branch and worktree for inspection — work is never silently dropped.

## Running multiple orchestrators

Several orchestrators can safely share one task directory and repo. Coordination uses plain files — no database, no daemon:

- **Atomic claim.** Picking a task creates a `.claim` directory with `mkdir` (atomic on every OS). If two orchestrators race, only one `mkdir` wins; the loser moves on. The claim records the owner's `pid`, `host`, start time, and a unique `instance` id.
- **Liveness by heartbeat.** The owner refreshes a `heartbeat` file while it works. Others judge a claim **only** by heartbeat age, never by the owner's pid — a pid is meaningless on a different machine. A claim whose heartbeat is younger than `ORCH_HEARTBEAT_MS` is always left alone.
- **Recovery.** If the heartbeat is stale, a claim is reclaimed only when either (a) the owner is on **this** machine and its pid is gone, or (b) the claim is older than the hard ceiling `ORCH_CLAIM_MAX_MS` (covers a crashed owner on another machine). Otherwise it is left alone until the ceiling, so a slow remote owner is never stolen from prematurely.
- **Unique identity.** Each orchestrator gets a globally-unique instance id (`<pid>-<random>`), so two machines never mistake each other's claims for their own.

Reclaiming a stale claim preserves the task's convergence count, so progress is never lost.

## Coding agents

- `pi` is the default. It uses pi's experiment tools and accepts `--model` / `ORCH_MODEL`; reasoning is resolved but not passed because pi has no documented reasoning flag here.
- `copilot` uses the standalone GitHub Copilot CLI: `copilot -p "<prompt>" -s --allow-all-tools --no-ask-user [--model <model>] [--reasoning-effort <level>]`.

Copilot limitations: install the `copilot` CLI and authenticate with `COPILOT_GITHUB_TOKEN` (or gh/GITHUB_TOKEN). Token usage is not reported in `-p -s` mode. Copilot runs a shell-based benchmark loop (`node <taskDir>\benchmark.js`) instead of pi's experiment tools.

The CLI preflights the SELECTED agent's prerequisites (binary + auth) before running.

### Adding a new coding agent

1. Create `src/<Name>Agent.ts` implementing `CodingAgent` (`name`, `checkPrerequisites()`, `spawn()`); accept `CodingAgentOptions` (extend it if you need extra options).
2. Register it in `src/agents.ts` `REGISTRY` (one line: `name: (opts) => new <Name>Agent(opts)`).
3. (Optional) Export it from `src/index.ts`.
4. Run `npm run all`. No `Engine.ts` changes are needed.

## Development

See `docs/DEVELOP.md` for TDD workflow, SOLID principles, and code conventions. See `docs/TESTING.md` for test conventions.

```bash
npm run c      # type-check
npm run t      # run tests
npm run tc     # tests + coverage
npm run all    # lint + type-check + tests + build
```
