# Worktree synchronization: scenarios and risks

This document catalogues every scenario where the main repo and worktree
can drift out of sync during a task's lifecycle, the current behaviour in
each case, and recommended mitigations.

## Background

The orchestrator keeps two Git trees per task:

| Tree | Location | Changes by |
|------|----------|------------|
| **Main repo** | The checkout the orchestrator runs in | Other tasks merging, manual commits, external CI |
| **Worktree** | `<worktreesDir>/<taskName>` on branch `orchestrator/<taskName>` | The coding agent (pi / copilot CLI) |

The worktree branch is created from the main repo's current branch (the
"base branch") at task pickup. From that point the two diverge: the base
advances as other work merges, and the worktree advances as the agent
commits.

### Key data structures

- **`.convergence_count`** — file on disk in the task directory.
  Incremented each time benchmark returns metric=0. Convergence threshold
  defaults to 3 (`ORCH_CONVERGE`).
- **`#worktrees`** — in-memory `Map<number, Worktree>` in Engine. Lost
  when the loop process restarts.
- **Agent commits** — pi's `log_experiment` commits to the worktree
  branch. Uncommitted changes are possible if the agent crashes or is
  killed mid-work.

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

| # | Scenario | Outcome | Risk |
|---|----------|---------|------|
| 1.1 | metric > 0 (normal) | `#prepareWorktree()` creates worktree from base, `cleanWorktree()` + `syncWithBase()`, spawns agent | ✅ Safe. Fresh worktree from current base |
| 1.2 | metric = 0 already | `#handleZero()` → convergence=1. No worktree created | ⚠️ See Phase 3 issue P3.4 |
| 1.3 | Benchmark crashes | Caught as metric=1 → same as 1.1 | ⚠️ Agent spawned against broken benchmark (separate issue) |

### Phase 2: Agent works (worktree active)

```
#prepareWorktree()
  → creates worktree (or reuses existing)
  → cleanWorktree(): discards uncommitted changes
  → syncWithBase(): merges latest base into worktree branch
#runSpawnCycle()
  → spawns agent (cwd = worktree)
  → agent reads, edits, commits in worktree
  → run benchmark in worktree
```

**State:** Worktree exists, may have committed and/or uncommitted changes
from agent. Main repo may have advanced (other tasks merging
concurrently).

| # | Scenario | Outcome | Risk |
|---|----------|---------|------|
| 2.1 | Agent commits, metric=0 | `#handleZero()` → convergence=1 | ✅ Safe. Committed changes persist in worktree |
| 2.2 | Agent commits, metric > 0 | `#handleFailure()` → FAILED, retry later | ✅ Safe. On retry, `#prepareWorktree()` cleans uncommitted + syncs with base. Committed changes preserved |
| 2.3 | Agent leaves uncommitted changes, metric=0 | `#handleZero()` → convergence=1 | **🔴 BUG.** Benchmark passed against uncommitted code. At merge time, only committed code is merged. Uncommitted changes are silently lost. See **B1** |
| 2.4 | Agent leaves uncommitted changes, metric > 0 | `#handleFailure()` → FAILED | ✅ On retry, `#prepareWorktree()` calls `cleanWorktree()` which discards uncommitted changes. Agent starts fresh |
| 2.5 | Agent crashes mid-commit | Partial state | ⚠️ Same as 2.3 or 2.4 depending on timing |
| 2.6 | Main repo advances while agent works | No immediate effect | ✅ `syncWithBase()` runs at next `#prepareWorktree()` or at merge |
| 2.7 | Another task merges to base during agent run, conflicting files | No immediate effect | ✅ Conflict detected at `syncWithBase()` or merge time |

### Phase 3: Convergence ticks (convergence 1 → 2 → 3)

After metric=0, the task stays IN_PROGRESS and is re-picked on the next
loop tick. The benchmark is re-run to confirm stability.

```
tick()
  → pick() re-picks our IN_PROGRESS task
  → existingWt = #worktrees.get(taskNumber)
  → if found: checkCwd = worktree (with agent's commits)
  → if NOT found: checkCwd = main repo (WRONG!)
  → run benchmark
  → metric=0? → incrementConvergence
  → convergence ≥ 3? → #mergeAndRemove()
```

**State:** Worktree has agent's committed changes. Main repo may have
advanced further.

| # | Scenario | Outcome | Risk |
|---|----------|---------|------|
| 3.1 | Same process, worktree in memory, metric=0 | convergence increments, no agent spawn, no worktree cleanup | ✅ Safe. Worktree unchanged, benchmark re-confirms |
| 3.2 | Same process, worktree in memory, metric > 0 (regression) | `resetConvergence()` → back to 0. `#prepareWorktree()` → `cleanWorktree()` + `syncWithBase()` → re-spawn agent | ✅ Safe. Uncommitted junk cleaned, base synced |
| 3.3 | Same process, base advanced between ticks, metric=0 | convergence increments. Benchmark passed against worktree (which has NOT synced with new base yet) | **⚠️ RISK.** Benchmark passes on stale worktree. Caught at merge (`syncWithBase` + re-benchmark in `#mergeAndRemove`). Not a bug but wasted convergence ticks |
| 3.4 | **Process restarted** between convergence ticks | `#worktrees` map is empty. `existingWt = undefined`. `checkCwd = this.#repo` (main repo) | **🔴 BUG.** Benchmark runs against main repo, not the worktree. Agent's committed work is invisible. See **B2** |
| 3.5 | Process restarted, convergence count was 2, metric=0 in main repo | convergence hits 3 → `#mergeAndRemove()` → but `#worktrees` is empty → `tree = null` → skips merge, marks CONVERGED | **🔴 BUG.** Task converges without merging agent's work. The worktree branch exists in git but is abandoned. See **B3** |
| 3.6 | Process restarted, convergence count was 2, metric > 0 in main repo | `resetConvergence()` → back to 0. Agent re-spawned. `#prepareWorktree()` finds no existing worktree, creates new one from base | **⚠️ RISK.** Old worktree branch exists in git. New worktree reuses it (via `#add()`). Agent's previous commits are on the branch. `cleanWorktree()` only cleans uncommitted. `syncWithBase()` merges base in. Previous agent work survives. Could be confusing but not data loss |

### Phase 4: Merge (convergence = 3)

```
#mergeAndRemove(task, wt)
  → acquireMergeLock()
  → stashParentChanges() (if autoStash)
  → syncWithBase(): merge latest base into worktree branch
  → run benchmark in worktree (final check)
  → runVerifyCmd() (if configured)
  → merge(): checkout base in main repo, merge --no-ff worktree branch
  → remove(): remove worktree + delete branch
```

**State:** Worktree branch has agent's commits + latest base merged in.
Main repo may have uncommitted changes (user's work).

| # | Scenario | Outcome | Risk |
|---|----------|---------|------|
| 4.1 | Clean main repo, clean merge | ✅ Merge succeeds, worktree removed, task CONVERGED | ✅ Safe |
| 4.2 | Main repo has uncommitted changes | `git checkout base` fails ("would overwrite local changes") | **🔴 BUG if autoStash=false (default).** Merge crashes. Caught by `#recoverMergeFailure()` → BLOCKED or stash+retry. But the error message is confusing. See **B4** |
| 4.3 | Base advanced since last convergence tick, no conflicts | `syncWithBase()` succeeds. Re-benchmark passes. Merge succeeds | ✅ Safe. This is the designed path |
| 4.4 | Base advanced, syncWithBase conflicts | MergeConflictError → task BLOCKED, branch kept | ✅ Safe. Human resolves |
| 4.5 | Re-benchmark fails after syncWithBase | `resetConvergence()` → `return 'rework'`. Agent gets another round | ✅ Safe. Prevents merging broken code |
| 4.6 | verifyCmd fails | `resetConvergence()` → `return 'rework'` | ✅ Safe |
| 4.7 | Merge conflicts (branch→base) | MergeConflictError → BLOCKED, branch kept | ✅ Safe |
| 4.8 | Another orchestrator holds the merge lock | `return 'locked'` → retry next tick | ✅ Safe |
| 4.9 | Agent had uncommitted changes that passed benchmark but weren't committed | Only committed changes are merged. Uncommitted work lost | **🔴 BUG.** Same as B1 — silent data loss |

### Phase 5: Failure and retry

```
#handleFailure()
  → incrementFailures()
  → failures >= MAX_FAILURES? → markBlocked()
  → else: release(FAILED)

Next tick picks up FAILED task:
  → pick() moves to IN_PROGRESS
  → #prepareWorktree() → cleanWorktree() + syncWithBase()
  → agent re-spawned
```

| # | Scenario | Outcome | Risk |
|---|----------|---------|------|
| 5.1 | Same process, worktree in memory | `#prepareWorktree()` cleans + syncs. Agent's committed changes on branch survive. Agent builds on previous work | ✅ Safe |
| 5.2 | Process restarted, worktree not in memory | `#prepareWorktree()` creates new Worktree object. `#add()` finds existing branch, reuses it. Committed changes survive | ✅ Safe. `cleanWorktree()` + `syncWithBase()` bring it current |
| 5.3 | Process restarted, worktree directory deleted externally | `#add()` → worktree prune + re-add. Branch may or may not exist | ⚠️ If branch exists, previous commits survive. If not, starts fresh. Both acceptable |

---

## Identified bugs

### B1: Uncommitted changes pass benchmark but are lost at merge

**Trigger:** Agent exits without committing all changes. Benchmark runs
in worktree (sees uncommitted files). metric=0. Convergence increments.
At merge, `git merge --no-ff` only includes committed changes.

**Impact:** Task converges but the merged code is different from what the
benchmark validated. Uncommitted changes are silently lost.

**Why it happens:** `cleanWorktree()` (which would discard uncommitted
changes) only runs inside `#prepareWorktree()`, which is only called
when metric > 0 (agent needs to work). When metric=0, no cleanup
happens.

**Mitigation — auto-commit before benchmark:**
After the agent exits and before running the benchmark, run
`git add -A && git commit --allow-empty -m "agent work"` in the
worktree. This ensures everything the agent touched is committed.
Alternatively, check for uncommitted changes before `#handleZero()` and
refuse to count it as convergence if the worktree is dirty.

**Recommended fix:**
In `#runSpawnCycle()`, after agent exits but before `this.#run(task, ...)`:
```ts
// Commit any uncommitted agent work so merge captures everything
if (wt) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: wt.path });
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: wt.path });
  } catch {
    // There are staged changes — commit them
    execFileSync('git', ['commit', '-m', 'agent work (auto-committed by orchestrator)'],
      { cwd: wt.path });
  }
}
```

### B2: Process restart loses worktree reference — benchmark measures wrong tree

**Trigger:** Loop process restarts (Ctrl+C, crash, deploy). `#worktrees`
is in-memory only. On next tick, `existingWt = undefined`, so benchmark
runs against main repo instead of worktree.

**Impact:** If convergence count > 0 from a previous process, the next
tick's benchmark measures the main repo (which doesn't have the agent's
work). This either: (a) gives metric > 0 → resets convergence
unnecessarily, or (b) gives metric = 0 (main repo already satisfies the
check) → increments convergence against the wrong tree.

**Why it happens:** Worktree associations are in-memory only. No
persistence.

**Recommended fix:**
On task pickup, if convergence count > 0 and no worktree in memory,
check if the git branch `orchestrator/<taskName>` exists and the
worktree directory is present. If so, reconstruct the Worktree object
and add it to `#worktrees`.

```ts
// In tick(), after pick(), before running benchmark:
if (task.convergenceCount > 0 && !this.#worktrees.has(task.taskNumber)) {
  // Try to reconnect to the worktree from a previous process
  const wt = new Worktree(this.#repo, { name: task.taskName, ... });
  if (wt.exists) {
    this.#worktrees.set(task.taskNumber, wt);
  } else {
    // Worktree is gone — convergence count is meaningless
    task.resetConvergence();
  }
}
```

### B3: Convergence without merge (orphaned worktree branch)

**Trigger:** Process restarted at convergence count 2. Benchmark passes
against main repo. `#handleZero()` sets convergence=3.
`task.hasConverged = true`. `tree = null` (no worktree in memory). Code
at line 371–372 skips merge and marks CONVERGED.

**Impact:** Task is marked CONVERGED but the agent's work on branch
`orchestrator/<taskName>` is never merged. The branch is orphaned.

**Why it happens:** Same root cause as B2 — in-memory worktree map lost
on restart.

**Recommended fix:** Same as B2 — reconnect worktree before convergence
check. If the worktree cannot be found and convergence would trigger
merge, reset convergence instead of skipping merge.

### B4: Main repo uncommitted changes block merge

**Trigger:** User has uncommitted work in the main repo (editing files,
running experiments). `merge()` calls `git checkout base` in the main
repo. Git refuses: "Your local changes would be overwritten."

**Impact:** Merge fails. Without `autoStashBeforeMerge`, the task ends
up BLOCKED. Error message says "local changes" without clarifying it
means the main repo, not the worktree.

**Current mitigation:** `autoStashBeforeMerge` option (default: false).
When enabled, stashes main repo changes before checkout.

**Recommended fix:** Enable `autoStashBeforeMerge` by default. The
orchestrator should handle the common case autonomously. If stash fails,
block the task with a clear message: "Main repo has uncommitted changes
that conflict with checkout. Commit or stash your work, then unblock the
task."

---

## Risk matrix: convergence count × process state × base state

### Convergence count 0 (first agent run)

| Base state | Process state | What happens | Safe? |
|------------|--------------|--------------|-------|
| Clean, unchanged | Same process | Normal: create worktree, spawn agent | ✅ |
| Advanced (other merge) | Same process | Normal: `syncWithBase()` during `#prepareWorktree()` | ✅ |
| Advanced | New process | Normal: creates fresh worktree from current base | ✅ |
| Has uncommitted changes | Same process | No effect (worktree is separate checkout) | ✅ |

### Convergence count 1 (re-checking after first metric=0)

| Base state | Process state | What happens | Safe? |
|------------|--------------|--------------|-------|
| Clean | Same process | Re-run benchmark in worktree. Worktree has agent's commits | ✅ |
| Advanced | Same process | Re-run in worktree. Worktree has NOT synced yet (no `syncWithBase()` on metric=0 path). Base drift not visible until merge | ⚠️ Wasted tick if merge will fail |
| Clean | **New process** | **B2:** `#worktrees` empty. Benchmark runs in main repo. May reset convergence unnecessarily or advance it against wrong tree | 🔴 |
| Advanced | **New process** | **B2:** Same as above, compounded by base drift | 🔴 |

### Convergence count 2 (one more pass needed)

| Base state | Process state | What happens | Safe? |
|------------|--------------|--------------|-------|
| Clean | Same process | Re-run in worktree. metric=0 → convergence=3 → merge | ✅ |
| Advanced | Same process | Re-run in worktree (stale). metric=0 → merge → `syncWithBase()` at merge catches drift | ✅ (merge gate is robust) |
| Clean | **New process** | **B2+B3:** Benchmark in main repo. If metric=0 → convergence=3 → merge skipped (no worktree). Task falsely CONVERGED | 🔴 |
| Advanced | **New process** | Same as above. If metric > 0 in main repo → convergence reset. Agent re-spawned, previous work on branch reused (via `#add()`) | ⚠️ Convergence lost but work preserved |

### At merge (convergence = 3)

| Base state | Main repo dirty? | What happens | Safe? |
|------------|-----------------|--------------|-------|
| Clean | No | `syncWithBase()` → re-benchmark → merge | ✅ |
| Advanced, no conflicts | No | `syncWithBase()` merges base → re-benchmark → merge | ✅ |
| Advanced, conflicts | No | `syncWithBase()` → MergeConflictError → BLOCKED | ✅ |
| Any | **Yes** | **B4:** `git checkout base` fails. BLOCKED or stash+retry | ⚠️ |

---

## Summary of fixes

| Bug | Severity | Fix | Complexity |
|-----|----------|-----|------------|
| **B1** Uncommitted changes lost at merge | High | Auto-commit after agent exits, before benchmark | Low |
| **B2** Process restart loses worktree | High | Reconnect worktree from git branch + directory on pickup | Medium |
| **B3** Convergence without merge | Critical | Require worktree for merge. Reset convergence if worktree missing | Low |
| **B4** Main repo dirty blocks merge | Medium | Default `autoStashBeforeMerge` to true | Low |

### Priority order

1. **B3** — fix first. A false CONVERGED is worse than any other outcome.
   The fix is simple: in `#handleZero()`, if `hasConverged && tree === null`,
   reset convergence and log a warning instead of marking CONVERGED.

2. **B2** — fix second. Reconnect worktree on pickup. Without this, every
   process restart resets convergence progress at best, and triggers B3
   at worst.

3. **B1** — fix third. Auto-commit agent work. Without this, uncommitted
   agent changes create a gap between what the benchmark validates and
   what gets merged.

4. **B4** — fix last. Default autoStash to true. The current workaround
   (setting the option) works; it's just not the default.

---

## Appendix: Full tick lifecycle diagram

```
tick()
 ├─ pick() → task IN_PROGRESS
 ├─ existingWt = #worktrees.get(taskNumber)  ← IN-MEMORY ONLY
 │   ├─ found → checkCwd = worktree
 │   └─ not found → checkCwd = main repo  ← BUG if convergence > 0
 ├─ run benchmark(checkCwd)
 │   ├─ metric = 0 → #handleZero()
 │   │   ├─ incrementConvergence (file on disk, survives restart)
 │   │   ├─ convergence < 3 → return (re-check next tick)
 │   │   └─ convergence ≥ 3 → #mergeAndRemove()
 │   │       ├─ tree found → syncWithBase + re-benchmark + verifyCmd + merge
 │   │       └─ tree null → CONVERGED without merge  ← BUG B3
 │   └─ metric > 0 → resetConvergence()
 │       └─ #prepareWorktree()
 │           ├─ create or reuse worktree
 │           ├─ cleanWorktree() (discard uncommitted)
 │           └─ syncWithBase() (merge latest base)
 │       └─ #runSpawnCycle()
 │           ├─ spawn agent (works in worktree)
 │           ├─ [B1: agent may leave uncommitted changes]
 │           ├─ run benchmark(worktree)
 │           │   ├─ metric = 0 → #handleZero()
 │           │   └─ metric > 0 → #handleFailure() → FAILED
 │           └─ return metric
 └─ #handleFailure()
     ├─ failures < MAX → release(FAILED), retry later
     └─ failures ≥ MAX → markBlocked()
```

### Process restart impact

```
Process 1:                          Process 2 (after restart):
─────────────────────────           ──────────────────────────
agent works → metric=0             
convergence = 1                    
#worktrees has worktree ✅         
                                    tick() → pick()
                              ┌──→  #worktrees is EMPTY
                              │     existingWt = undefined
                              │     checkCwd = main repo  ← WRONG
                              │     convergence_count file = 1 (on disk)
                              │     
                              │     If metric=0 in main repo:
                              │       convergence = 2 (B2: wrong tree)
                              │       ... eventually 3 → B3: merge skipped
                              │     
                              │     If metric>0 in main repo:
                              │       resetConvergence → 0
                              │       #prepareWorktree → reconnects to branch
                              │       agent works again (previous commits survive)
```
