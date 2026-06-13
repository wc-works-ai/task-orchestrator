# Worktree synchronization: scenarios and risks

This document catalogues every scenario where the main repo and worktree
can drift out of sync during a task's lifecycle. Each scenario is marked:

- ✅ **SAFE** — currently handled correctly
- 🔴 **BUG** — current code has a defect
- ⚠️ **RISK** — works but fragile or wasteful

---

## Background

The orchestrator keeps two Git trees per task:

| Tree | Location | Changes by |
|------|----------|------------|
| **Main repo** | The checkout the orchestrator runs in | Other tasks merging, manual commits, external CI |
| **Worktree** | `<worktreesDir>/<taskName>` on branch `orchestrator/<taskName>` | The coding agent (pi / copilot CLI) |

The base branch is captured **once at Engine construction** (not per
pickup). Worktrees are created **lazily** — only when metric > 0 and
`.git` exists — inside `#prepareWorktree()`. If the branch
`orchestrator/<taskName>` already exists (from a prior run), it is
reused with its existing commits.

### Key data structures

- **`.convergence_count`** — file on disk in the task directory.
  Incremented each time benchmark returns metric=0. Threshold is
  configurable via `ORCH_CONVERGE` (default 3). If the file is missing
  or corrupted, it is silently treated as 0.
- **`#worktrees`** — **in-memory** `Map<number, Worktree>` in Engine.
  **Lost when the loop process restarts.** This is the root cause of
  bugs B2 and B3.
- **Agent commits** — the orchestrator does NOT auto-commit agent work.
  Behaviour depends on the agent backend:
  - **PiSpawner**: prompt instructs the agent to use `log_experiment`,
    which commits at experiment boundaries. Edits between
    `log_experiment` calls remain uncommitted.
  - **CopilotCliAgent**: prompt contains **no commit instruction**.
    Copilot may or may not commit on its own. **B1 (silent loss of
    uncommitted work) is the default failure mode** for every successful
    Copilot run unless the agent independently decides to commit.
  
  Only committed changes survive cleanup and merge.
- **Merge lock** — directory-based lock (`.orchestrator-merge-lock`) in
  the repo. Only one orchestrator can merge at a time. Stale locks are
  reclaimed after `ORCH_MERGE_LOCK_MS` timeout.
- **Claims** — directory-based per-task lock (`.claim/`). Prevents two
  orchestrator instances from processing the same task. Released on
  completion, failure, or stale-heartbeat recovery.
- **Base branch** — captured once at Engine construction
  (`#detectBaseBranch()`), never refreshed. If the user switches branches
  mid-run or `git pull` advances the base, the orchestrator is unaware.
  "Base advanced" in this doc means the local branch pointer advanced
  (e.g., another task merged), not that the remote was fetched.

### What is safe by design

These are NOT bugs — the architecture handles them correctly:

| Area | Why it's safe |
|------|---------------|
| **Parallel ticks (same process)** | `#owned` Set prevents the same task from being processed by two concurrent ticks. Second tick skips and returns null |
| **Parallel orchestrator instances** | Task claims (`.claim` directory + owner file) prevent two instances from picking the same task. Merge lock prevents concurrent merges |
| **Same-task convergence serialization** | Convergence is serialized by claim ownership; only one process can increment convergence for a given task at a time |
| **Cross-task worktree isolation** | Each task has its own worktree and branch. When task A merges (advancing base), task B's worktree stays stale until its next `syncWithBase()` — called at `#prepareWorktree()` and `#mergeAndRemove()` |
| **Branch reuse on restart** | When a new process creates a Worktree for a task whose branch already exists, `#add()` reuses the branch. Previous agent commits survive. `cleanWorktree()` only removes uncommitted changes |
| **Recovery preserves convergence** | `#recover()` releases stale claims (→ FAILED) but does NOT reset `.convergence_count`. The task can resume convergence from where it left off (modulo B2) |
| **`--unblock` resets task state** | Clears failures, convergence, and claim. Moves task to PENDING. Does NOT delete the worktree or branch — agent's committed work is preserved for the next run |
| **Convergence counter corruption** | If `.convergence_count` is deleted or unreadable, `convergenceCount` returns 0. The task re-enters the normal flow. No crash, no stuck state |
| **Scope enforcement** | Advisory only (prompt-based). The orchestrator does not validate scope. Out-of-scope edits are handled by git: conflicts surface at `syncWithBase()` or merge, and `cleanWorktree()` discards uncommitted out-of-scope edits on retry |
| **`node_modules` copy failure** | The copy (`cpSync`) is best-effort; failure is swallowed. The agent may encounter missing dependencies, but this manifests as a benchmark failure (metric > 0), not a crash. The task retries naturally |
| **Task dependencies and convergence** | Dependent tasks wait for the dependency's `CONVERGED` status, not its convergence count. A task at convergence=2 does not unblock dependents. The stale-code risk from dependencies is really B3 (false CONVERGED) |
| **No-spawn mode** | When no spawner is configured, no worktree is ever created. Tasks converge by benchmark alone with `cwd = repo`. `tree === null` at merge time is legitimate in this mode (see B3 nuance) |

---

## Lifecycle phases

### Phase 1: First pickup (PENDING → IN_PROGRESS)

```
tick()
  → pick() moves task to IN_PROGRESS
  → no existing worktree in #worktrees
  → checkCwd = this.#repo (main repo)
  → run benchmark in main repo
```

**State:** No worktree exists yet. Benchmark runs against the main repo.
This is intentional — the initial check determines whether work is
needed.

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 1.1 | metric > 0 (normal) | `#prepareWorktree()` creates worktree from base, `cleanWorktree()` + `syncWithBase()`, spawns agent | ✅ SAFE — fresh worktree from current base |
| 1.2 | metric = 0 already | `#handleZero()` → convergence=1. No worktree created | ✅ SAFE — if threshold is 1, task converges immediately (task was already done). If threshold > 1, re-checked next tick |
| 1.3 | Benchmark crashes (process error) | Caught as metric=1 → same as 1.1 | ⚠️ RISK — agent spawned against broken benchmark. Separate issue |

### Phase 2: Agent works (worktree active)

```
#prepareWorktree()
  → creates worktree (or reuses existing)
  → cleanWorktree(): best-effort discard of uncommitted changes
  → syncWithBase(): merges latest base into worktree branch
      on any error (conflict or otherwise): resetForRetry() (hard reset to base)
#runSpawnCycle()
  → spawns agent (cwd = worktree)
  → agent reads, edits, may or may not commit
  → run benchmark in worktree
```

**State:** Worktree exists, may have committed and/or uncommitted changes
from agent. Main repo may have advanced (other tasks merging
concurrently).

**Note on cleanup:** `cleanWorktree()` is best-effort — both
`git checkout -- .` and `git clean -fd` swallow errors. If cleanup fails,
the worktree may still be dirty when the agent starts. This is not
currently detected or logged.

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 2.1 | Agent commits all work, metric=0 | `#handleZero()` → convergence=1 | ✅ SAFE — committed changes persist in worktree |
| 2.2 | Agent commits all work, metric > 0 | `#handleFailure()` → FAILED, retry later | ✅ SAFE — on retry, `resetForRetry()` then `#prepareWorktree()` clean + sync. Committed changes preserved on branch |
| 2.3 | Agent leaves uncommitted changes, metric=0 | `#handleZero()` → convergence=1 | 🔴 **BUG B1.** Benchmark passed against uncommitted code. At merge, only committed code is merged. Uncommitted changes silently lost |
| 2.4 | Agent leaves uncommitted changes, metric > 0 | `#handleFailure()` → FAILED | ⚠️ RISK — on retry, `cleanWorktree()` discards both tracked edits and untracked files. **All near-success agent work is silently destroyed** unless the agent committed it. No recoverability |
| 2.5 | Agent crashes mid-work | Partial committed + uncommitted state | ⚠️ RISK — same as 2.3 or 2.4 depending on what was committed before crash |
| 2.6 | Main repo advances while agent works | No immediate effect | ✅ SAFE — `syncWithBase()` runs at next `#prepareWorktree()` or at merge |
| 2.7 | Another task merges, conflicting files | No immediate effect | ✅ SAFE — conflict detected at `syncWithBase()` or merge time |
| 2.8 | `syncWithBase()` fails during `#prepareWorktree()` | `resetForRetry()` — hard reset to base branch | ✅ SAFE — both MergeConflictError and plain Error fall through to catch. Agent starts fresh on latest base. Previous committed work on the branch is lost by the hard reset |
| 2.9 | Agent edits files outside declared scope | Committed out-of-scope changes persist | ⚠️ RISK — no enforcement. May conflict with other tasks at sync/merge. Prompt-based scope is advisory only |
| 2.10 | `cleanWorktree()` fails silently | Agent starts on dirty worktree | ⚠️ RISK — errors swallowed by try/catch. No detection or logging. Agent may see stale files from previous run |

### Phase 3: Convergence ticks (convergence 1 → 2 → threshold)

After metric=0, the task stays IN_PROGRESS and is re-picked on the next
loop tick. The benchmark is re-run to confirm stability.

```
tick()
  → pick() re-picks our IN_PROGRESS task
  → existingWt = #worktrees.get(taskNumber)
  → if found: checkCwd = worktree (with agent's commits)
  → if NOT found: checkCwd = main repo (see B2)
  → run benchmark
  → metric=0? → incrementConvergence
  → convergence ≥ threshold? → #mergeAndRemove()
```

**State:** Worktree has agent's committed changes. Main repo may have
advanced further. No `syncWithBase()` or `cleanWorktree()` runs during
the metric=0 convergence path — the worktree is re-measured as-is.

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 3.1 | Same process, worktree in memory, metric=0 | Convergence increments, no agent spawn, no worktree cleanup | ✅ SAFE — worktree unchanged, benchmark re-confirms |
| 3.2 | Same process, worktree in memory, metric > 0 | `resetConvergence()` → 0. `#prepareWorktree()` → clean + sync → re-spawn agent | ✅ SAFE — base synced, agent retries |
| 3.3 | Same process, base advanced, metric=0 in worktree | Convergence increments. Worktree NOT synced with new base | ⚠️ RISK — benchmark passes on stale worktree. Caught at merge: `syncWithBase()` + re-benchmark + verifyCmd guard against merging broken code. Not a bug but wastes convergence ticks if merge will rework |
| 3.4 | **Process restarted**, convergence > 0 | `#worktrees` empty. Benchmark runs against main repo | 🔴 **BUG B2** — agent's committed work invisible. See B2 |
| 3.5 | Process restarted, convergence = threshold−1, metric=0 in main repo | Convergence reaches threshold → `tree = null` → merge skipped → false CONVERGED | 🔴 **BUG B3** — agent's work orphaned. See B3 |
| 3.6 | Process restarted, convergence > 0, metric > 0 in main repo | `resetConvergence()` → 0. `#prepareWorktree()` → reuses existing branch | ⚠️ RISK — convergence lost but committed work preserved. Agent rebuilds |
| 3.7 | `.convergence_count` deleted between ticks | `convergenceCount` returns 0. Task restarts convergence from scratch | ✅ SAFE — no crash, just wasted progress |

### Phase 4: Merge (convergence reaches threshold)

```
#mergeAndRemove(task, wt)
  → acquireMergeLock() (directory-based, cross-process safe)
  → stashParentChanges() (if autoStash enabled)
  → syncWithBase(): merge latest base into worktree branch
  → run benchmark in worktree (final check after sync)
  → runVerifyCmd() (if configured)
  → merge(): git checkout base in MAIN REPO, git merge --no-ff branch
      (main repo is left on the base branch after success)
  → remove(): git worktree remove --force + git branch -D
```

**State:** Worktree branch has agent's commits + latest base merged in.
Main repo may have uncommitted changes (user's work).

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 4.1 | Clean main repo, clean merge | Merge succeeds, worktree + branch removed, task CONVERGED | ✅ SAFE |
| 4.2 | Main repo has uncommitted changes | `git checkout base` fails | 🔴 **BUG B4** if `autoStashBeforeMerge=false` (default). Caught by recovery → BLOCKED. Error message confusing |
| 4.3 | Base advanced, no conflicts | `syncWithBase()` succeeds. Re-benchmark passes. Merge succeeds | ✅ SAFE |
| 4.4 | Base advanced, syncWithBase() conflicts | MergeConflictError → BLOCKED, branch kept | ✅ SAFE |
| 4.5 | Re-benchmark fails after sync | `resetConvergence()` → rework. Agent retries | ✅ SAFE |
| 4.6 | verifyCmd fails after sync | `resetConvergence()` → rework | ✅ SAFE |
| 4.7 | Merge conflicts (branch → base) | MergeConflictError → BLOCKED, branch kept | ✅ SAFE |
| 4.8 | Another orchestrator holds merge lock | `return 'locked'` → retry next tick | ✅ SAFE |
| 4.9 | Uncommitted changes passed benchmark but aren't committed | Only committed code merged. Uncommitted work lost | 🔴 **BUG B1** |
| 4.10 | SIGKILL during merge | Main repo left on base branch, possibly mid-merge (`.git/MERGE_HEAD` set). Lock dir remains | ⚠️ RISK — neither `cleanWorktree()` nor `syncWithBase()` checks for in-progress merges before starting. Next retry: `merge()` fails → caught → `git merge --abort` → one tick wasted. `prevBranch` captured during recovery may be wrong (base instead of user's topic branch). Lock auto-reclaimed after timeout |
| 4.11 | SIGKILL during syncWithBase (in worktree) | Worktree left with `.git/MERGE_HEAD`. `cleanWorktree()` does NOT abort merges. Next `syncWithBase()` fails → caught → rethrown → `resetForRetry()` → `git reset --hard base` **discards agent's committed work** | ⚠️ RISK — silent data loss. Same as F5 in Opus review |
| 4.12 | Merge lock stale (previous holder crashed) | Lock reclaimed after `ORCH_MERGE_LOCK_MS` timeout. mkdir retried atomically | ✅ SAFE |

### Phase 5: Failure and retry

```
tick() picks up FAILED task:
  → pick() moves to IN_PROGRESS
  → if task.isFailed && worktree in memory: resetForRetry()
  → #prepareWorktree() → cleanWorktree() + syncWithBase()
  → agent re-spawned
```

Note: on retry with worktree in memory, `resetForRetry()` runs BEFORE
`#prepareWorktree()`, so the worktree is cleaned twice (reset then
clean+sync). Redundant but harmless.

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 5.1 | Same process, worktree in memory | `resetForRetry()` + `#prepareWorktree()` clean + sync | ✅ SAFE |
| 5.2 | Process restarted, worktree not in memory | `#prepareWorktree()` creates new Worktree, reuses existing branch. Committed changes survive **only if `syncWithBase()` succeeds**. If base conflicts with branch, catch block runs `resetForRetry()` → `git reset --hard base` → **agent's committed work on branch is silently lost** | ⚠️ RISK — silent data loss on conflict during retry |
| 5.3 | Worktree directory deleted externally | `#add()` → prune + re-add from branch | ✅ SAFE |
| 5.4 | Task blocked (MAX_FAILURES) | `markBlocked()`. Worktree and branch preserved for inspection | ✅ SAFE |

### Phase 6: Recovery and special operations

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 6.1 | Stale claim recovery (owner crashed) | Claim released → FAILED. Convergence preserved | ✅ SAFE (subject to B2 on next pickup) |
| 6.2 | `--unblock` a blocked/failed task | Resets failures, convergence, claim → PENDING. Worktree/branch NOT deleted | ✅ SAFE |
| 6.3 | `--stop` / `.stop` file mid-convergence | Convergence count persists on disk. Worktree untouched. Task stays IN_PROGRESS until claim recovery releases it | ✅ SAFE |
| 6.4 | Auth/environment failure at convergence=2 | `#handleEnvironmentalFailure()` → task released FAILED (no retry consumed). Convergence NOT explicitly reset | ⚠️ RISK — convergence stays at 2 on disk. On rerun, if metric=0 on first check, convergence hits 3 and merges. This is actually correct (the work was done) but may be surprising |
| 6.5 | EXDEV shard move (cross-device task dir) | Fallback: `cpSync()` + `rmSync()` — NOT atomic | ⚠️ RISK — crash between copy and delete can leave duplicate task dirs. `pick()` scans by name so duplicate visible. Confusing but recoverable |

### Phase 7: Multiple orchestrators on one task tree

When two or more `orchestrator --loop` instances run against the same
task directory (e.g., on different machines via shared NFS):

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 7.1 | Both try to pick the same PENDING task | Claim is atomic (`.claim.lock` written with `wx` flag). Exactly one wins | ✅ SAFE |
| 7.2 | Orchestrator A dies, B reclaims stale task | `#recover()` checks heartbeat age → releases claim → FAILED. B's `#prepareWorktree()` constructs new Worktree pointing at same branch/dir. `cleanWorktree()` wipes A's uncommitted work (silent loss) | ⚠️ RISK — committed work survives, uncommitted is lost (same as B1 but triggered by handoff) |
| 7.3 | Both try to merge different tasks simultaneously | Merge lock (`.orchestrator-merge-lock` dir) ensures only one merges at a time. Loser gets `'locked'` → retries | ✅ SAFE |
| 7.4 | Convergence counter race (claim recovered mid-tick) | `incrementConvergence` is read-modify-write, not atomic. If claim transitions mid-flight, both processes can write the same value. Effect bounded: one count lost (never duplicated). Worst case: one extra convergence tick | ⚠️ RISK — bounded, non-critical |

### node_modules synchronization

On every `#prepareWorktree()`, Engine runs
`cpSync(repo/node_modules, worktree/node_modules, { recursive: true })`.
The call is wrapped in `try/catch` and **all errors are swallowed**.

`#prepareWorktree()` is NOT called during convergence ticks (metric=0
path). Worktree retains whatever node_modules was last copied.

| Failure mode | Symptom | Status |
|-------------|---------|--------|
| ENOSPC / EACCES / no source dir | Silent. Benchmark fails with "Cannot find module" | ⚠️ RISK |
| `npm install` between convergence ticks | Worktree uses stale copy until next `#prepareWorktree()` | ⚠️ RISK |
| Package removed from repo (`npm uninstall`) | Worktree retains orphan; `require()` still resolves | ⚠️ RISK |
| Copy succeeds normally | Worktree has matching dependencies | ✅ SAFE |

---

## Identified bugs

### 🔴 B1: Uncommitted changes pass benchmark but are lost at merge

**Severity:** High  
**Scenarios:** 2.3, 2.5, 4.9

**Trigger:** Agent exits without committing all changes. Benchmark runs
in worktree (sees uncommitted files). metric=0. Convergence increments.
At merge, `git merge --no-ff` only includes committed changes.

**Impact:** Task converges but the merged code differs from what the
benchmark validated. Uncommitted changes are silently lost.

**Root cause:** The orchestrator does NOT auto-commit agent work.

**Recommended fix:** In `#runSpawnCycle()`, after agent exits but before
running the benchmark, auto-commit any uncommitted work:
```ts
if (wt) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: wt.path, encoding: 'utf-8' }).trim();
  if (dirty) {
    execFileSync('git', ['add', '-A'], { cwd: wt.path });
    execFileSync('git', ['commit', '-m', 'agent work (auto-committed by orchestrator)'], { cwd: wt.path });
  }
}
```

### 🔴 B2: Process restart loses worktree reference

**Severity:** High  
**Scenarios:** 3.4, 3.5, 3.6

**Trigger:** Loop process restarts. `#worktrees` is in-memory only.

**Impact:** Convergence re-checks measure the wrong tree (main repo
instead of worktree).

**Root cause:** Worktree associations are in-memory only.

**Recommended fix:** On task pickup, if convergence > 0, try to
reconnect to existing worktree. Handle four cases:
1. **Branch + worktree dir exist** → reconnect
2. **Branch exists, no worktree dir** → recreate worktree from branch
3. **Worktree dir exists, no branch** → reset convergence (broken state)
4. **Neither exists** → reset convergence (clean start)

### 🔴 B3: Convergence without merge (orphaned worktree branch)

**Severity:** Critical  
**Scenarios:** 3.5

**Trigger:** Process restarted at convergence = threshold−1. Benchmark
passes against main repo (B2). `#handleZero()` → `tree = null` → skips
merge → marks CONVERGED.

**Impact:** Agent's work is never merged. Branch is orphaned.

**Nuance:** `tree === null` is legitimate in no-spawn mode (no worktree
was ever created). The fix must distinguish "no worktree because
no-spawn mode" from "worktree lost due to restart."

**Recommended fix:** In `#handleZero()`:
- If `hasConverged && tree === null && this.#spawn !== null`:
  attempt worktree reconnection (B2 fix). If reconnection fails, reset
  convergence and log warning instead of marking CONVERGED.
- If `this.#spawn === null`: allow convergence (no-spawn mode, no
  worktree expected).

### ⚠️ B4: Main repo uncommitted changes block merge

**Severity:** Medium  
**Scenarios:** 4.2

**Trigger:** User has uncommitted work in the main repo.

**Impact:** Merge fails → task BLOCKED. Error message confusing.

**Current mitigation:** `autoStashBeforeMerge` (default: false).

**Recommended fix:** Default to true.

---

## Risk matrix: convergence count × process state × base state

### Convergence count 0 (first run)

| Base state | Process | What happens | Status |
|------------|---------|--------------|--------|
| Clean | Same | Create worktree, spawn agent | ✅ SAFE |
| Advanced | Same | `syncWithBase()` in `#prepareWorktree()` | ✅ SAFE |
| Advanced | New | Fresh worktree from current base | ✅ SAFE |
| Dirty | Same | No effect (worktree is separate) | ✅ SAFE |

### Convergence count 1+ (re-checking)

| Base state | Process | What happens | Status |
|------------|---------|--------------|--------|
| Clean | Same | Re-run benchmark in worktree | ✅ SAFE |
| Advanced | Same | Re-run in stale worktree. Caught at merge | ⚠️ RISK |
| Any | **New** | **B2:** benchmark in main repo, not worktree | 🔴 BUG |

### At merge (convergence = threshold)

| Base state | Dirty? | What happens | Status |
|------------|--------|--------------|--------|
| Clean | No | sync → benchmark → verify → merge | ✅ SAFE |
| Advanced, no conflict | No | sync → merge | ✅ SAFE |
| Advanced, conflict | No | MergeConflictError → BLOCKED | ✅ SAFE |
| Any | **Yes** | **B4:** checkout fails → BLOCKED | ⚠️ RISK |

---

## Summary of fixes

| Bug | Severity | Fix | Complexity |
|-----|----------|-----|------------|
| **B3** | Critical | Guard `tree===null` + reconnect. Allow null only in no-spawn mode | Low |
| **B2** | High | Reconnect worktree from branch/dir on pickup when convergence > 0 | Medium |
| **B1** | High | Auto-commit agent work after spawn, before benchmark | Low |
| **B4** | Medium | Default `autoStashBeforeMerge` to true | Low |

### Priority order

1. **B3** — false CONVERGED is the worst outcome.
2. **B2** — every restart wastes progress or triggers B3.
3. **B1** — uncommitted changes create gap between validated and merged code.
4. **B4** — has working workaround (`autoStashBeforeMerge`).

---

## Appendix A: Simplified tick lifecycle

```
tick()
 ├─ pick() → task IN_PROGRESS
 ├─ existingWt = #worktrees.get(taskNumber)  ← IN-MEMORY ONLY
 │   ├─ found → checkCwd = worktree
 │   └─ not found → checkCwd = main repo  ← BUG B2 if convergence > 0
 ├─ run benchmark(checkCwd)
 │   ├─ metric = 0 → #handleZero()
 │   │   ├─ incrementConvergence (file on disk, survives restart)
 │   │   ├─ < threshold → return (re-check next tick)
 │   │   └─ ≥ threshold → #mergeAndRemove()
 │   │       ├─ tree found → sync + benchmark + verify + merge
 │   │       └─ tree null + spawn configured → BUG B3
 │   │       └─ tree null + no spawn → ✅ converge (no worktree expected)
 │   └─ metric > 0 → resetConvergence()
 │       └─ #prepareWorktree() → clean + sync
 │       └─ #runSpawnCycle()
 │           ├─ spawn agent
 │           ├─ [B1: may leave uncommitted changes]
 │           └─ run benchmark → metric 0 or >0
 └─ #handleFailure()
     ├─ < MAX_FAILURES → FAILED, retry later
     └─ ≥ MAX_FAILURES → BLOCKED
```

## Appendix B: Process restart impact

```
Process 1:                          Process 2 (after restart):
─────────────────────────           ──────────────────────────
agent works → metric=0             
convergence = 1                    
#worktrees has worktree ✅         
                                    tick() → pick()
                              ┌──→  #worktrees is EMPTY
                              │     existingWt = undefined
                              │     checkCwd = main repo  ← WRONG (B2)
                              │     
                              │     If metric=0 in main repo:
                              │       convergence = 2 (wrong tree)
                              │       ... → threshold → B3: merge skipped
                              │     
                              │     If metric>0 in main repo:
                              │       resetConvergence → 0
                              │       #prepareWorktree → reconnects to branch
                              │       agent works again (commits survive)
```

## Appendix C: What --unblock resets

| State | Reset? | Detail |
|-------|--------|--------|
| `.status` | ✅ Yes | → PENDING |
| `.failure_count` | ✅ Yes | → 0 |
| `.convergence_count` | ✅ Yes | → 0 |
| `.claim` directory | ✅ Yes | removed |
| Worktree directory | ❌ No | preserved for next run |
| Git branch | ❌ No | preserved (commits survive) |
| Agent logs | ❌ No | preserved for debugging |
| In-memory `#worktrees` | ❌ No | untouched in any running engine |

**Important:** When the loop next picks up the unblocked task,
`Worktree.#add()` detects the existing branch and reuses it —
**conflict-causing commits from the original failure are still on the
branch.** `cleanWorktree()` only removes uncommitted files;
`syncWithBase()` then merges the latest base into the branch. The same
conflict may recur.

**For a true fresh start:** manually run
`git worktree remove --force .worktrees/<name>` and
`git branch -D orchestrator/<name>` before unblocking.
