# Task Orchestrator

Autonomous task execution engine. Spawns AI agents to complete tasks defined in markdown files, measures progress via benchmarks, and converges tasks when acceptance criteria are met.

```
$ orchestrator add "fix-auth-bug" --goal "Fix authentication timeout" --metric "pass_count" --scope "src/auth.ts tests/auth.test.ts"
$ orchestrator               # run one task
$ orchestrator --loop         # run until all tasks converge
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
4. **Convergence** — when the benchmark reaches its target for 3 consecutive runs, the task is merged back

If merge-back is blocked, the task is marked BLOCKED and the worktree is kept for inspection while the run continues. Interactive runs may auto-stash parent repo changes and retry the merge immediately.

Agent summaries include total token usage when the spawned agent reports usage data. `agent.log` is summary-only by default for `pi`; set `ORCH_AGENT_LOG_RAW=1` to also write raw spawned-agent stdout/stderr. Raw logs are capped at 10 MiB by default and keep the latest output when truncated.

Long loop runs print an `Overview:` counts line after each tick and a final `Summary:` with one icon-prefixed line per task.

## CLI

| Command | Description |
|---|---|
| `orchestrator` | Run current repo until all tasks complete |
| `orchestrator --once` | Process one tick and exit |
| `orchestrator --status` | Show task dashboard |
| `orchestrator --check` | Check prerequisites |
| `orchestrator --stop` | Signal running instances to stop |
| `orchestrator --task <n>` | Force-pick specific task |
| `orchestrator --auto-stash` | Stash parent repo changes before merging |
| `orchestrator --keep-alive` | Keep looping through transient idle/cooldown periods |
| `orchestrator --agent <name>` | Coding agent: `pi` (default) or `copilot` |
| `orchestrator --model <model>` | Model override passed to the coding agent |
| `orchestrator --reasoning <level>` | Reasoning effort override for supported agents |
| `orchestrator add <name>` | Scaffold a new task |
| `orchestrator edit <n>` | Edit task metadata |

By default, tasks and worktrees are stored together under the state root:

```text
<state-root>\<repo-slug>\tasks
<state-root>\<repo-slug>\worktrees
```

The default state root is `<home>\task-orchestrator`.

Explicit `--tasks` and `--worktrees` paths override those derived locations.

## Environment variables

| Variable | Default | Controls |
|---|---|---|
| `ORCH_REPO` | current directory | Target repo/folder override |
| `ORCH_STATE_ROOT` | `<home>\task-orchestrator` | Orchestrator state root override |
| `ORCH_TASKS` | `<state-root>\<repo-slug>\tasks` | Task directory override |
| `ORCH_AGENT` | `pi` | Coding agent: `pi` or `copilot` |
| `ORCH_MODEL` | agent default | Model override passed to the coding agent |
| `ORCH_REASONING` | unset | Reasoning effort override for supported agents |
| `ORCH_WORKTREES` | `<state-root>\<repo-slug>\worktrees` | Worktree directory override |
| `ORCH_AUTO_STASH` | unset | Stash parent repo changes before merging when set to `1`, `true`, `yes`, or `on` |
| `ORCH_CONVERGE` | `3` | Zero-runs to converge |
| `ORCH_MAX_FAILURES` | `5` | Failed attempts before BLOCKED; integer >= 1 or `infinite` |
| `ORCH_KEEP_ALIVE` | unset | Keep looping through transient idle/cooldown periods when set to `1`, `true`, `yes`, or `on` |
| `ORCH_IDLE_SLEEP_MS` | `5000` | Sleep interval between keep-alive idle ticks |
| `ORCH_HEARTBEAT_MS` | `300000` | Stale claim timeout |
| `ORCH_AGENT_LOG_MAX_BYTES` | `10485760` | Maximum `agent.log` size before older output is truncated |
| `ORCH_AGENT_LOG_RAW` | unset | Write raw spawned-agent stdout/stderr to `agent.log` when set to `1`, `true`, `yes`, or `on` |
| `ORCH_LOG_LEVEL` | `normal` | Console verbosity: `quiet`, `normal`, or `verbose`; quiet still writes full `orchestrator.log` |

## Task structure

```
tasks/pending/T01-my-task/
├── autoresearch.md   # Goal, metric, scope, acceptance criteria
├── autoresearch.sh   # Auto-generated experiment runner
└── benchmark.js      # Measures metric, outputs "METRIC <name>=<value>"
```

Optional `autoresearch.md` metadata:

| Field | Values | Controls |
|---|---|---|
| `**Model:**` | agent-specific model name | Task-level model override; falls back to `--model` / `ORCH_MODEL` |
| `**Reasoning:**` | agent-specific effort level | Task-level reasoning override; falls back to `--reasoning` / `ORCH_REASONING` |
| `**Retry limit:**` | integer >= 1, `infinite`, `unlimited`, or `inf` | Failed attempts before BLOCKED; falls back to `ORCH_MAX_FAILURES` |

Dependencies wait for all referenced tasks to converge; if any dependency is terminally BLOCKED, dependents are automatically BLOCKED transitively, while still-retrying FAILED dependencies keep dependents waiting.

## Coding agents

- `pi` is the default. It uses pi's experiment tools and accepts `--model` / `ORCH_MODEL`; reasoning is resolved but not passed because pi has no documented reasoning flag here.
- `copilot` uses the standalone GitHub Copilot CLI: `copilot -p "<prompt>" -s --allow-all-tools --no-ask-user [--model <model>] [--reasoning-effort <level>]`.

Copilot limitations: install the `copilot` CLI and authenticate with `COPILOT_GITHUB_TOKEN` (or gh/GITHUB_TOKEN). Token usage is not reported in `-p -s` mode. Copilot runs a shell-based benchmark loop (`node <taskDir>\benchmark.js`) instead of pi's experiment tools.

## Development

See `docs/DEVELOP.md` for TDD workflow, SOLID principles, and code conventions. See `docs/TESTING.md` for test conventions.

```bash
npm run c      # type-check
npm run t      # run tests
npm run tc     # tests + coverage
npm run all    # lint + type-check + tests + build
```
