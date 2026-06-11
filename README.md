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

Requires Node.js >= 22 and [pi](https://github.com/earendil-works/pi) CLI installed.

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

## CLI

| Command | Description |
|---|---|
| `orchestrator --state-root <dir>` | Run current repo until all tasks complete |
| `orchestrator --state-root <dir> --once` | Process one tick and exit |
| `orchestrator --state-root <dir> --status` | Show task dashboard |
| `orchestrator --state-root <dir> --check` | Check prerequisites |
| `orchestrator --state-root <dir> --stop` | Signal running instances to stop |
| `orchestrator --state-root <dir> --task <n>` | Force-pick specific task |
| `orchestrator --state-root <dir> add <name>` | Scaffold a new task |
| `orchestrator --state-root <dir> edit <n>` | Edit task metadata |

By default, tasks and worktrees are stored together under the required state root:

```text
<state-root>\<repo-slug>\tasks
<state-root>\<repo-slug>\worktrees
```

Explicit `--tasks` and `--worktrees` paths override those derived locations.

## Environment variables

| Variable | Default | Controls |
|---|---|---|
| `ORCH_REPO` | current directory | Target repo/folder override |
| `ORCH_STATE_ROOT` | required | Orchestrator state root |
| `ORCH_TASKS` | `<state-root>\<repo-slug>\tasks` | Task directory override |
| `ORCH_MODEL` | pi default | Model override passed to `pi` |
| `ORCH_WORKTREES` | `<state-root>\<repo-slug>\worktrees` | Worktree directory override |
| `ORCH_CONVERGE` | `3` | Zero-runs to converge |
| `ORCH_MAX_FAILURES` | `5` | Failures before BLOCKED |
| `ORCH_HEARTBEAT_MS` | `300000` | Stale claim timeout |

## Task structure

```
tasks/pending/T01-my-task/
├── autoresearch.md   # Goal, metric, scope, acceptance criteria
├── autoresearch.sh   # Auto-generated experiment runner
└── benchmark.js      # Measures metric, outputs "METRIC <name>=<value>"
```

## Development

See `docs/DEVELOP.md` for TDD workflow, SOLID principles, and code conventions. See `docs/TESTING.md` for test conventions.

```bash
npm run c      # type-check
npm run t      # run tests
npm run tc     # tests + coverage
npm run all    # lint + type-check + tests + build
```
