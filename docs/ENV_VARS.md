# Environment Variables Reference

Complete guide to configuring the Task Orchestrator. **Resolution order:** CLI flag > env var > default.

## Quick Summary

**Absolutely required to get started:**
- None! The orchestrator works with defaults.

**Recommended to set:**
- `ORCH_AGENT` — which coding agent to use (default: `pi`)
- `ORCH_MODEL` — model override (e.g., `gpt-5`, `claude-opus`)

**Often customized:**
- `ORCH_STATE_ROOT` — where tasks/worktrees live (default: `$HOME/task-orchestrator`)
- `ORCH_CONVERGE` — runs needed to confirm success (default: `3`)
- `ORCH_MAX_FAILURES` — attempts before giving up (default: `5`)

## All Variables by Group

### Paths

| Variable | CLI flag | Purpose | Default | Example |
|---|---|---|---|---|
| `ORCH_REPO` | `--repo` | Target repository folder | current directory | `/home/alice/my-repo` |
| `ORCH_STATE_ROOT` | `--state-root` | Where tasks and worktrees live | `$HOME/task-orchestrator` | `/mnt/tasks` |
| `ORCH_TASKS` | `--tasks` | Task directory (auto-derived if not set) | `<state-root>/<repo-slug>/tasks` | `/custom/tasks/path` |
| `ORCH_WORKTREES` | `--worktrees` | Worktree directory (auto-derived if not set) | `<state-root>/<repo-slug>/worktrees` | `/custom/worktrees/path` |

### Coding Agent

| Variable | CLI flag | Purpose | Default | Example |
|---|---|---|---|---|
| `ORCH_AGENT` | `--agent` | Which agent: `pi` or `copilot` | `pi` | `copilot` |
| `ORCH_MODEL` | `--model` | Model override to pass to agent | agent default | `gpt-5`, `claude-opus-4.8` |
| `ORCH_REASONING` | `--reasoning` | Reasoning effort level (if supported) | unset | `high`, `extended` |

### Run Mode

| Variable | CLI flag | Purpose | Default | Example |
|---|---|---|---|---|
| `ORCH_KEEP_ALIVE` | `--keep-alive` | Keep looping through transient idle/cooldown | `off` | `1` or `true` |
| `ORCH_INFINITE` | `--infinite`, `--loop` | Daemon mode: never exit, wait for new tasks | `off` | `1` or `true` |
| `ORCH_IDLE_SLEEP_MS` | none (env only) | Poll interval when idle (milliseconds) | `5000` | `10000` |
| `ORCH_PARALLEL` | `--parallel` | Max concurrent tasks (0=unlimited) | `1` | `2`, `4`, `0` |

### Convergence & Merge

| Variable | CLI flag | Purpose | Default | Example |
|---|---|---|---|---|
| `ORCH_CONVERGE` | none (env only) | Zero-metric runs needed to consider task converged | `3` | `5` |
| `ORCH_KEEP_CONVERGED` | `--keep-converged` | Max converged task dirs to retain (0 = unlimited) | `100` | `ORCH_KEEP_CONVERGED=50` |
| `ORCH_MAX_FAILURES` | none (env only) | Failed attempts before marking task BLOCKED | `5` | `10` or `infinite` |
| `ORCH_AUTO_STASH` | `--auto-stash` | Stash parent repo changes before merging | `off` | `1` or `true` |
| `ORCH_MERGE_LOCK_MS` | none (env only) | Break stale merge lock (crashed merger) after this many ms | `600000` (10 min) | `300000` |
| `ORCH_VERIFY_CMD` | none (env only) | Shell command to run in worktree before merge | unset | `npm run tc` |

### Concurrency & Timeouts

| Variable | CLI flag | Purpose | Default | Example |
|---|---|---|---|---|
| `ORCH_HEARTBEAT_MS` | none (env only) | Heartbeat freshness window for claim (milliseconds) | `300000` (5 min) | `600000` |
| `ORCH_CLAIM_MAX_MS` | none (env only) | Hard claim ceiling; reclaim stale claim across machines (ms) | `1800000` (30 min) | `3600000` |
| `ORCH_PROGRESS_TIMEOUT` | none (env only) | Kill agent if no output for this long (milliseconds) | `120000` (2 min) | `300000` |

### Logging

| Variable | CLI flag | Purpose | Default | Example |
|---|---|---|---|---|
| `ORCH_LOG_LEVEL` | none (env only) | Console verbosity: `quiet`, `normal`, or `verbose` | `normal` | `verbose` |
| `ORCH_AGENT_LOG_RAW` | none (env only) | Write raw agent output to `agent.log` | `off` | `1` or `true` |
| `ORCH_AGENT_LOG_MAX_BYTES` | none (env only) | Max size of agent.log before truncation (bytes) | `10485760` (10 MB) | `52428800` |

## Check Your Configuration

After setting env vars or flags, verify they took effect:

```bash
$ orchestrator --config
Configuration (CLI flag > env var > default)

Paths:
ORCH_REPO (--repo) = /home/alice/my-repo   [flag]
ORCH_STATE_ROOT (--state-root) = /mnt/tasks   [env]
...
```

**Output shows:**
- Each resolved value
- Its source: `flag`, `env`, or `default`
- Derived paths fully expanded

Run this **before a long run** to catch typos or missing env vars.

## Quick Start Examples

### Minimal Setup
Use all defaults, just run:
```bash
$ orchestrator
```

### Development (Common)
Recommended for contributors:
```bash
$ export ORCH_AGENT=copilot
$ export ORCH_MODEL=gpt-5-mini
$ export ORCH_KEEP_ALIVE=1        # don't exit on idle
$ orchestrator --loop             # daemon mode
```

### Production (Unattended)
For long-running, reliable convergence:
```bash
$ export ORCH_AGENT=copilot
$ export ORCH_CONVERGE=5          # stricter: 5 consecutive zeros
$ export ORCH_MAX_FAILURES=3      # give up sooner on stuck tasks
$ export ORCH_LOG_LEVEL=quiet     # less noise
$ export ORCH_STATE_ROOT=/mnt/persistent-tasks
$ orchestrator --loop
```

### Multiple Orchestrators on Same Host
Safe to run multiple instances sharing one task directory:
```bash
# Instance 1 (terminal 1)
$ export ORCH_STATE_ROOT=/shared/tasks
$ orchestrator --loop

# Instance 2 (terminal 2)
$ export ORCH_STATE_ROOT=/shared/tasks
$ orchestrator --loop
```

Coordination is automatic: claim heartbeats, stale-lock detection, atomic merges.

### Custom Paths (Shared Storage)
For NFS or cloud storage:
```bash
$ export ORCH_REPO=/work/my-repo
$ export ORCH_STATE_ROOT=/shared-storage/orchestrator
$ export ORCH_TASKS=/shared-storage/tasks
$ export ORCH_WORKTREES=/fast-local-disk/worktrees   # keep worktrees local
$ orchestrator
```

### Debug Mode
Troubleshoot what's happening:
```bash
$ export ORCH_LOG_LEVEL=verbose
$ export ORCH_AGENT_LOG_RAW=1
$ orchestrator --once              # run one task, don't loop
```

Then check logs:
- `<state-root>/<repo-slug>/tasks/T01-name/agent.log` — raw agent output

## Boolean Environment Variables

Accept: `1`, `true`, `yes`, or `on` (case-insensitive).

```bash
export ORCH_KEEP_ALIVE=1      # on
export ORCH_KEEP_ALIVE=true   # on
export ORCH_KEEP_ALIVE=off    # off
```

## CLI Flags vs Environment Variables

You can mix them—CLI flags take priority:

```bash
# These are equivalent:
export ORCH_AGENT=pi
orchestrator                          # uses pi from env

orchestrator --agent copilot          # uses copilot from flag (overrides env)
```

Typical workflow:
- Set permanent config in `~/.bashrc`, `~/.zshrc`, or CI/CD secrets
- Use CLI flags for one-off overrides

## Timeouts and Performance Tuning

### Concurrency (running multiple orchestrators)

- `ORCH_HEARTBEAT_MS` — how often the owner refreshes its claim file (default: 5 min)
- `ORCH_CLAIM_MAX_MS` — when to give up waiting and reclaim (default: 30 min)

Decrease for faster reclaim on crashed instances; increase if merges are slow.

### Agent Responsiveness

- `ORCH_PROGRESS_TIMEOUT` — kill agent if silent for this long (default: 2 min)
- `ORCH_IDLE_SLEEP_MS` — how often to check for new tasks when idle (default: 5 sec)

Increase `ORCH_PROGRESS_TIMEOUT` if agents are doing long computations with no output.

### Convergence Strictness

- `ORCH_CONVERGE` — require this many zero-metric runs (default: 3)
- `ORCH_MAX_FAILURES` — give up after this many failed attempts (default: 5)

Increase both for production to be more confident; decrease for fast iteration.

## Notes

- **Parallel task execution:** Set `ORCH_PARALLEL` to run multiple tasks concurrently. Default is 1 (serial, backward compatible). 0 = unlimited (run all ready tasks in parallel). Values > 100 clamp to 100. Example: `ORCH_PARALLEL=2` runs up to 2 tasks at once.
- **Converged task pruning:** Once converged task dirs exceed `ORCH_KEEP_CONVERGED` (default 100), older ones are removed and their metadata appended to `converged/.archive.jsonl`. Set to `0` to disable pruning.
- **Pre-merge verification:** Set `ORCH_VERIFY_CMD` to run a command (e.g., `npm run tc`) before merge. If it fails, task goes back to agent.
- **Auto-stash:** Recommended if parent repo has uncommitted changes; `ORCH_AUTO_STASH` will stash them before merge, then restore.
- **Derived paths:** If you don't set `ORCH_TASKS` or `ORCH_WORKTREES`, they're auto-derived from `ORCH_STATE_ROOT` and repo slug. Explicit paths override derivation.
- **Millisecond values:** Timeouts are in milliseconds (1000 ms = 1 sec). Default values are production-tested.
