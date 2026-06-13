# Worktree synchronization

Each scenario: ✅ safe, ⚠️ risk, 🔴 problem.

## Architecture

Each task gets a git worktree on branch `orchestrator/<taskName>`,
branched from the task's target branch (`.target_branch` file).

| Component | Persistence |
|-----------|-------------|
| Worktree (`<worktreesDir>/<taskName>`) | On disk; deleted on convergence |
| Target branch (`.target_branch`) | On disk; set at task creation |
| Worktree map (`Engine.#worktrees`) | In-memory; reconnected on restart |
| Convergence count (`.convergence_count`) | On disk; 0 if missing/corrupt |
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
| Parallel orchestrators | Claims + merge lock |
| Cross-task isolation | Separate worktree + branch per task |
| Branch reuse on restart | `#add()` reuses branch; cleanup only removes uncommitted |
| Recovery preserves convergence | `#recover()` releases claim but keeps `.convergence_count` |
| `--unblock` | Resets failures/convergence/claim → PENDING; worktree/branch preserved |
| Counter corruption | Missing/unreadable → 0 |
| Scope | Advisory (prompt-based); conflicts caught by git |
| `node_modules` copy failure | Best-effort; benchmark fails → natural retry |
| Dependencies | Wait for CONVERGED status, not count |
| Non-git repo / `--no-worktree` | Degrades to benchmark loop; warned in log; no cleanup of main folder |
| Auto-commit | After agent exits; merge captures validated code |
| Target branch | Per-task `.target_branch`; merge goes to correct branch |
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
| 3 | Benchmark crashes | ⚠️ Agent spawned against broken benchmark |

### Agent work

| # | Scenario | Status |
|---|----------|--------|
| 4 | Agent commits, metric = 0 | ✅ |
| 5 | Agent commits, metric > 0 → FAILED; next tick starts fresh from base | ✅ |
| 6 | Uncommitted changes → auto-committed before benchmark | ✅ |
| 7 | Agent crashes → auto-commit captures whatever was written | ✅ |
| 8 | Main repo advances → synced at next `#prepareWorktree` or merge | ✅ |
| 9 | `syncWithBase()` fails → hard reset to base | ⚠️ Agent commits lost |
| 10 | `cleanWorktree()` fails silently | ⚠️ Errors swallowed |
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
| 36 | EXDEV shard move → non-atomic fallback | ⚠️ Duplicate on crash |

### Multiple orchestrators

| # | Scenario | Status |
|---|----------|--------|
| 37 | Both pick same task → claim is atomic | ✅ |
| 38 | Orchestrator A dies, B reclaims → committed work survives | ✅ |
| 39 | Concurrent merges → merge lock serializes | ✅ |
| 40 | Convergence counter race → bounded (one count lost) | ⚠️ |

### No-worktree mode

| # | Scenario | Status |
|---|----------|--------|
| 41 | `--no-worktree` or no `.git` → agent works in main repo | ✅ |
| 42 | No cleanup of main repo | ✅ |
| 43 | Convergence by benchmark only; no merge | ✅ |

## Remaining problem

### 🔴 Stale benchmark

Benchmark is a static artifact. By pickup time, codebase may have changed.

| Mode | Effect |
|------|--------|
| False negative | Criteria unreachable → agent burns retries |
| False positive | No-op check → false convergence |
| Crash | Missing imports → broken benchmark |
| Infra regression | Another merge broke build/test |

**Planned fix:** crash detection, no-progress detection, baseline regression.

## Fixed issues

| ID | Problem | Fix |
|----|---------|-----|
| B1 | Uncommitted changes lost at merge | `Worktree.autoCommit()` |
| B2 | Process restart loses worktree | `#tryReconnectWorktree()` |
| B3 | Convergence without merge | Guard in `#handleZero()` |
| B4 | Dirty repo blocks merge | Default `autoStashBeforeMerge=true` |
| B6 | Merge into wrong branch | `.target_branch` per task |
| P1 | Repo left on target branch | `checkout prevBranch` after merge |
| P2 | Stash never restored | `stash pop` in finally block |
| P4 | Staged changes leak | `git reset HEAD` in `cleanWorktree()` |

## Appendix: --unblock

| State | Reset? |
|-------|--------|
| `.status` | ✅ → PENDING |
| `.failure_count` | ✅ → 0 |
| `.convergence_count` | ✅ → 0 |
| `.claim` | ✅ removed |
| `.target_branch` | ❌ preserved |
| Worktree / branch | ❌ preserved |
| Agent logs | ❌ preserved |

**Note:** After unblock, existing branch is reused. Conflict-causing
commits survive — same conflict may recur. For a fresh start, delete
the worktree and branch manually before unblocking.
