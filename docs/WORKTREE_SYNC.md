# Worktree synchronization

Each scenario: ✅ safe, ⚠️ risk, 🔴 problem.

## Architecture

Each task gets a git worktree on branch `orchestrator/<taskName>`,
branched from the task's target branch. Task state lives in SQLite
(`tasks/state.db`); the worktree and task content live on disk.

| Component | Persistence |
|-----------|-------------|
| Worktree (`<worktreesDir>/<taskName>`) | On disk; deleted on convergence |
| Target branch | In `state.db`; set at task creation |
| Convergence count | In `state.db`; preserved across restarts and recovery |
| Claim (owner + heartbeat token) | In `state.db`; cleared on release/recovery |
| Agent commits | On worktree branch; auto-committed before benchmark |

### Behaviors

- **Worktrees created lazily** — only when metric > 0, `.git` exists,
  and `--no-worktree` is not set
- **Auto-commit** — `Worktree.autoCommit()` after agent exits, before
  benchmark. Merge captures what benchmark validated
- **Auto-stash** — on by default (`ORCH_AUTO_STASH`). Stashed before
  merge, popped after (on all exit paths including rework)
- **Branch restore** — after merge, repo restored to user's branch
- **Reconnection** — on restart with convergence > 0, worktree
  reconnected from disk. If gone, convergence resets to 0
- **No-worktree mode** — `--no-worktree` or `ORCH_NO_WORKTREE=1` skips
  all git/worktree operations. Agent works directly in main repo. No
  cleanup, no merge, no isolation

## Guarantees

| Area | Mechanism |
|------|-----------|
| Parallel ticks (same process) | `#owned` Set |
| Parallel workers (same host) | DB claim token + merge lock |
| Cross-task isolation | Separate worktree + branch per task |
| Branch reuse on restart | `#add()` reuses branch; cleanup only removes uncommitted |
| Recovery preserves convergence | `recoverStale()` releases the claim, keeps the convergence count |
| `--unblock` | Resets failures/convergence/claim → PENDING; worktree/branch preserved |
| Counter corruption | N/A — counts are integer columns in `state.db` |
| Scope | Advisory (prompt-based); conflicts caught by git |
| `node_modules` copy failure | Best-effort; benchmark fails → natural retry |
| Broken benchmark | Crash / no METRIC → task BLOCKED with a structured reason; no spawn, no retry |
| Dependencies | Wait for CONVERGED status, not count |
| Non-git repo / `--no-worktree` | Degrades to benchmark loop; warned in log; no cleanup of main folder |
| Auto-commit | After agent exits; merge captures validated code |
| Target branch | Per-task, from `state.db`; merge goes to correct branch |
| Auto-stash | Stash before merge, pop after (all paths) |
| Branch restore | After merge, restored to user's branch |
| Staged cleanup | `cleanWorktree()` runs `git reset HEAD` + `checkout -- .` + `clean -fd` |
| Worktree reconnection | On restart with convergence > 0; if gone, resets convergence |

## Scenarios

### Pickup (PENDING → IN_PROGRESS)

| # | Scenario | Status |
|---|----------|--------|
| 1 | metric > 0 → create worktree, spawn agent | ✅ |
| 2 | metric = 0 → convergence starts (no worktree) | ✅ |
| 3 | Benchmark crashes or emits no METRIC | ✅ Classified as a defect → task BLOCKED (no spawn, no retry) |

### Agent work

| # | Scenario | Status |
|---|----------|--------|
| 4 | Agent commits, metric = 0 | ✅ |
| 5 | Agent commits, metric > 0 → FAILED; next tick starts fresh from base | ✅ |
| 6 | Uncommitted changes → auto-committed before benchmark | ✅ |
| 7 | Agent crashes → auto-commit captures whatever was written | ✅ |
| 8 | Main repo advances → synced at next `#prepareWorktree` or merge | ✅ |
| 9 | `syncWithBase()` fails → hard reset to base | ⚠️ Agent commits lost |
| 10 | `cleanWorktree()` fails → agent may start on dirty worktree | ⚠️ Logged; self-corrects via benchmark |
| 11 | Agent edits outside scope | ⚠️ Prompt-based scope only |

### Convergence (metric = 0, re-checking)

| # | Scenario | Status |
|---|----------|--------|
| 12 | Same process, metric = 0 | ✅ |
| 13 | Same process, metric > 0 → convergence resets, agent retries | ✅ |
| 14 | Base advanced → worktree stale; caught at merge | ⚠️ Wastes convergence ticks |
| 15 | Process restarted, worktree found → reconnected | ✅ |
| 16 | Process restarted, worktree gone → convergence reset | ✅ |

### Merge (convergence = threshold)

| # | Scenario | Status |
|---|----------|--------|
| 17 | Clean merge | ✅ |
| 18 | Main repo dirty → auto-stashed, popped after merge | ✅ |
| 19 | Base advanced, no conflicts → sync + merge | ✅ |
| 20 | Base advanced, sync conflicts → BLOCKED | ✅ |
| 21 | Benchmark fails after sync → rework | ✅ |
| 22 | verifyCmd fails → rework | ✅ |
| 23 | Merge conflict → BLOCKED, branch kept | ✅ |
| 24 | Another orchestrator holds lock → retry next tick | ✅ |
| 25 | SIGKILL during merge → lock remains | ⚠️ Auto-reclaimed after timeout |
| 26 | SIGKILL during sync → hard reset wipes commits | ⚠️ Silent data loss |
| 27 | Branch restored after merge | ✅ |
| 28 | Stash popped after merge (all paths) | ✅ |

### Failure and retry

| # | Scenario | Status |
|---|----------|--------|
| 29 | Same process → `#prepareWorktree` cleans + syncs. Fresh start | ✅ |
| 30 | Process restarted → branch reused, clean + sync | ✅ |
| 31 | Sync conflicts on retry → hard reset, starts fresh | ⚠️ Agent work lost |
| 32 | MAX_FAILURES → BLOCKED, worktree preserved | ✅ |

### Recovery and operations

| # | Scenario | Status |
|---|----------|--------|
| 33 | Stale claim recovery → FAILED, convergence preserved | ✅ |
| 34 | `--unblock` → resets state, preserves worktree | ✅ |
| 35 | `--stop` mid-convergence → convergence persists | ✅ |

### Multiple workers (same host)

| # | Scenario | Status |
|---|----------|--------|
| 36 | Both pick same task → claim is an atomic DB update | ✅ |
| 37 | Worker A dies, B reclaims via stale heartbeat → committed work survives | ✅ |
| 38 | Concurrent merges → merge lock serializes | ✅ |
| 39 | Convergence increments → atomic DB update, no lost counts | ✅ |

### No-worktree mode

| # | Scenario | Status |
|---|----------|--------|
| 40 | `--no-worktree` or no `.git` → agent works in main repo | ✅ |
| 41 | No cleanup of main repo | ✅ |
| 42 | Convergence by benchmark only; no merge | ✅ |

## Remaining problem

### 🔴 Stale benchmark

Benchmark is a static artifact. By pickup time, the codebase may have changed.

| Mode | Effect | Status |
|------|--------|--------|
| Crash / no METRIC | Result unreliable | ✅ Defect → task BLOCKED |
| False negative | Criteria unreachable → agent burns retries | 🔴 no-progress detection |
| False positive | Benchmark trivially emits 0 → false convergence | 🔴 baseline regression |

**Planned fix:** no-progress detection, baseline regression.

## Fixed issues

| ID | Problem | Fix |
|----|---------|-----|
| B1 | Uncommitted changes lost at merge | `Worktree.autoCommit()` |
| B2 | Process restart loses worktree | `#tryReconnectWorktree()` |
| B3 | Convergence without merge | Guard in `#handleZero()` |
| B4 | Dirty repo blocks merge | Default `autoStashBeforeMerge=true` |
| B6 | Merge into wrong branch | Per-task target branch |
| P1 | Repo left on target branch | `checkout prevBranch` after merge |
| P2 | Stash never restored | `stash pop` in finally block |
| P4 | Staged changes leak | `git reset HEAD` in `cleanWorktree()` |
| B7 | Crash/no-METRIC benchmark spawned the agent & burned retries | Structured `BenchmarkOutcome` → `#handleBenchmarkDefect()` BLOCKs the task |

## Appendix: --unblock

| State (in `state.db`) | Reset? |
|-----------------------|--------|
| status | ✅ → PENDING |
| failures | ✅ → 0 |
| convergence | ✅ → 0 |
| claim (owner + token) | ✅ cleared |
| target branch | ❌ preserved |
| Worktree / branch | ❌ preserved |
| Agent logs | ❌ preserved |

**Note:** After unblock, existing branch is reused. Conflict-causing
commits survive — same conflict may recur. For a fresh start, delete
the worktree and branch manually before unblocking.
