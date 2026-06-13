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
| **Non-git repo** | If the main folder has no `.git` directory, the orchestrator skips all git operations: `#detectBaseBranch()` falls back to `'master'`, `#prepareWorktree()` skips worktree creation (guard: `existsSync('.git')`), agent works directly in the folder, `#handleZero()` converges without merge. Works as a simple benchmark loop but with no isolation — multiple tasks can stomp on each other's changes, and there is no rollback if the agent breaks things |

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
**Note:** The benchmark itself may be outdated — it was authored at task
creation time and the codebase may have evolved since (files renamed,
APIs changed, patterns moved). A stale benchmark can produce false
positives (metric=0 when task isn't done) or false negatives (metric>0
when criteria are unreachable).

| # | Scenario | Outcome | Status |
|---|----------|---------|--------|
| 1.1 | metric > 0 (normal) | `#prepareWorktree()` creates worktree from base, `cleanWorktree()` + `syncWithBase()`, spawns agent | ✅ SAFE — fresh worktree from current base. But benchmark may be outdated (false positive/negative possible) |
| 1.2 | metric = 0 already | `#handleZero()` → convergence=1. No worktree created | ⚠️ RISK — may be a **false zero** from a stale benchmark (e.g., checked file deleted → grep returns 0 → "pass"). If threshold=1, task converges immediately without any agent work |
| 1.3 | Benchmark crashes (process error) | Caught as metric=1 → same as 1.1 | ⚠️ RISK — benchmark itself is broken (stale imports, moved files). Agent spawned against unfixable benchmark, burns retries |

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
| 4.13 | **User switched main repo from branch A to B** while task was in progress | `merge()` runs `git checkout A` (the cached base) → switches main repo from B to A without consent. Agent work merged into A, not B. After merge, main repo is left on A | 🔴 **BUG B6** — user silently loses their current branch context. Agent work may land on the wrong branch. See **B6** |

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

## Identified bugs — implementation plans

### 🔴 B3: Convergence without merge (orphaned worktree branch)

**Severity:** Critical — false CONVERGED is the worst outcome  
**Scenarios:** 3.5  
**Priority:** Fix first

**Problem:** In `#handleZero()` (Engine.ts:344-375), when
`task.hasConverged` is true and `tree === null`, the code skips the
merge block entirely and marks the task CONVERGED at line 372. The
agent's work on branch `orchestrator/<taskName>` is never merged.

**Root cause:** `tree` is null because `#worktrees` (in-memory map) was
lost on process restart and `#handleZero()` doesn't attempt
reconnection.

**Nuance:** `tree === null` is legitimate in **no-spawn mode** (no
`#spawn` configured → no worktree was ever created). The fix must
distinguish this from "worktree lost due to restart."

#### Implementation plan

**File:** `src/Engine.ts` — `#handleZero()` method

**Change:** Before the `task.status = Status.CONVERGED` line (372), add
a guard:

```ts
// In #handleZero(), after the `if (tree) { ... }` block, before CONVERGED:
if (!tree && this.#spawn) {
  // A spawner is configured but we have no worktree. This means the
  // worktree was lost (process restart). Don't converge without merging.
  const reconnected = this.#tryReconnectWorktree(task);
  if (reconnected) {
    // Re-run merge with the reconnected worktree
    // (recursive call to #handleZero is safe — convergence count already at threshold)
    return await this.#handleZero(task, metric, reconnected);
  }
  // Could not reconnect — reset convergence, log, and return
  task.resetConvergence();
  this.#log(`T${task.taskNumber} convergence reached but worktree not found — resetting (process restart?); will retry`, 'transition');
  return { task: task.info, metric, converged: false };
}
```

**New method** `#tryReconnectWorktree(task)`:
```ts
#tryReconnectWorktree(task: TaskState): Worktree | null {
  const wt = new Worktree(this.#repo, {
    name: task.taskName,
    baseBranch: this.#baseBranch,
    ...(this.#worktreesDir ? { worktreesDir: this.#worktreesDir } : {}),
  });
  if (wt.exists) {
    this.#worktrees.set(task.taskNumber, wt);
    return wt;
  }
  // Worktree dir gone but branch may exist — try to recreate
  try {
    wt.create();
    this.#worktrees.set(task.taskNumber, wt);
    return wt;
  } catch {
    return null;
  }
}
```

**Tests:**
- `hasConverged && tree===null && spawn configured` → reconnect succeeds → merge runs
- `hasConverged && tree===null && spawn configured` → reconnect fails → convergence reset, not CONVERGED
- `hasConverged && tree===null && spawn===null` → converge normally (no-spawn mode)

---

### 🔴 B2: Process restart loses worktree reference

**Severity:** High — every restart wastes convergence or triggers B3  
**Scenarios:** 3.4, 3.5, 3.6  
**Priority:** Fix second (B3 fix is a safety net; B2 prevents the problem)

**Problem:** `#worktrees` is in-memory only. After restart, `existingWt`
is undefined, so benchmark runs against main repo instead of worktree.

**Root cause:** No persistence or reconnection logic for worktree
associations.

#### Implementation plan

**File:** `src/Engine.ts` — `tick()` method, after `pick()` and before
running the benchmark (between lines 196 and 225).

**Change:** Add worktree reconnection when an in-progress task has no
worktree in memory:

```ts
// After this.#owned.add(task.taskNumber), before running benchmark:
if (!this.#worktrees.has(task.taskNumber) && this.#spawn) {
  const reconnected = this.#tryReconnectWorktree(task);
  if (reconnected) {
    this.#log(`T${task.taskNumber} reconnected to existing worktree`);
  } else if (task.convergenceCount > 0) {
    // Worktree expected but gone — convergence is meaningless
    task.resetConvergence();
    this.#log(`T${task.taskNumber} worktree not found, convergence reset`, 'transition');
  }
}
```

This reuses `#tryReconnectWorktree()` from the B3 fix. The four cases:

| Branch exists? | Worktree dir exists? | Action |
|---------------|---------------------|--------|
| ✅ | ✅ | `wt.exists` → reconnect. Add to `#worktrees` |
| ✅ | ❌ | `wt.create()` → recreate from branch. Commits survive |
| ❌ | ✅ | Broken state. `wt.create()` → new branch from base. Old dir removed by prune |
| ❌ | ❌ | Nothing to reconnect. Reset convergence if > 0 |

**Tests:**
- Process restart with convergence=1, worktree exists → reconnects, benchmark runs in worktree
- Process restart with convergence=1, worktree gone → convergence reset to 0
- Process restart with convergence=0, worktree exists → reconnects (branch reuse for retry)
- Process restart with convergence=0, no worktree → no-op (normal first pickup)

---

### 🔴 B1: Uncommitted changes pass benchmark but are lost at merge

**Severity:** High — especially critical for CopilotCliAgent (no commit
instruction in prompt)  
**Scenarios:** 2.3, 2.5, 2.10, 4.9, 7.2  
**Priority:** Fix third

**Problem:** The orchestrator does NOT auto-commit agent work. If the
agent leaves uncommitted changes, the benchmark validates code that
won't be in the merge.

**Root cause:** No commit step between agent exit and benchmark run.

#### Implementation plan

**File:** `src/Engine.ts` — `#runSpawnCycle()` method (lines 500-517)

**Change:** After line 509 (after logging spawn result) and before
line 514 (`this.#run(task, ...)`), add auto-commit:

```ts
// Auto-commit any uncommitted agent work so merge captures everything
// the benchmark validates. Use git status --porcelain for an explicit
// dirty check (not exception-based flow).
if (wt) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain'],
      { cwd: wt.path, encoding: 'utf-8' }).trim();
    if (dirty) {
      execFileSync('git', ['add', '-A'], { cwd: wt.path });
      execFileSync('git', ['commit', '-m',
        'agent work (auto-committed by orchestrator)'],
        { cwd: wt.path });
      this.#log(`T${task.taskNumber} auto-committed uncommitted agent work`);
    }
  } catch {
    // Best-effort; if commit fails, benchmark still runs and the
    // B1 risk remains — but this is no worse than current behavior
  }
}
```

**Also:** Add `Worktree.autoCommit()` method to `src/Worktree.ts` for
cleanliness:
```ts
/** Commit any uncommitted changes. Returns true if a commit was made. */
autoCommit(message: string): boolean {
  const dirty = this.#gitInWT('status', '--porcelain').trim();
  if (!dirty) return false;
  this.#gitInWT('add', '-A');
  this.#gitInWT('commit', '-m', message);
  return true;
}
```

**Tests:**
- Agent leaves uncommitted files → auto-committed before benchmark
- Agent commits everything → no auto-commit (clean worktree)
- Auto-commit fails (e.g., git lock) → swallowed, benchmark still runs
- Verify merged code includes auto-committed changes

---

### ⚠️ B4: Main repo uncommitted changes block merge

**Severity:** Medium — has working workaround  
**Scenarios:** 4.2  
**Priority:** Fix last

**Problem:** `Worktree.merge()` calls `git checkout base` in the main
repo. If the user has uncommitted changes, git refuses.

**Current mitigation:** `autoStashBeforeMerge` option (default: false).

#### Implementation plan

**File:** `src/Engine.ts` — constructor (line 102)

**Change:** Default `autoStashBeforeMerge` to `true`:
```ts
// Before:
this.#autoStashBeforeMerge = opts.autoStashBeforeMerge ?? false;
// After:
this.#autoStashBeforeMerge = opts.autoStashBeforeMerge ?? true;
```

**Also:** Add `ORCH_AUTO_STASH` env var in `src/env.ts`:
```ts
get autoStash() { return (process.env.ORCH_AUTO_STASH ?? 'true') !== 'false'; },
```

Update constructor:
```ts
this.#autoStashBeforeMerge = opts.autoStashBeforeMerge ?? env.autoStash;
```

**Tests:**
- Default behavior: main repo with uncommitted changes → stashed → merge succeeds → stash popped
- `ORCH_AUTO_STASH=false` → old behavior (merge fails → BLOCKED)
- Stash pop conflict after merge → logged but merge still succeeds

---

### 🔴 B6: User branch switch causes merge into wrong branch

**Severity:** High — user silently loses current branch context  
**Scenarios:** 4.13

**Problem:** The base branch is captured once at Engine construction
(`#detectBaseBranch()` → `this.#baseBranch`). If the user switches the
main repo from branch A to branch B while tasks are running,
`Worktree.merge()` still does `git checkout A` — silently switching the
user's repo from B back to A and merging agent work into A.

**Root cause:** `this.#base` in Worktree is a frozen string set at
construction. `merge()` uses it for `git checkout` and `git merge`
without checking what branch the repo is currently on or whether the
base is still the intended target.

**Impact:**
- User's main repo is silently switched to branch A
- Agent work merged into A even if user intended B
- After merge, main repo is left on A (not restored to B)

#### Implementation plan

**Option A — Re-detect base before merge** (recommended)

**File:** `src/Engine.ts` — `#mergeAndRemove()` (line 380)

Before calling `wt.merge()`, verify the main repo is still on the
expected base branch:

```ts
const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
  { cwd: this.#repo, encoding: 'utf-8' }).trim();
if (currentBranch !== this.#baseBranch) {
  this.#log(`T${task.taskNumber} WARNING: main repo is on '${currentBranch}' ` +
    `but task was created against '${this.#baseBranch}' — blocking task to avoid ` +
    `merging into wrong branch`, 'always');
  task.markBlocked();
  return 'rework';
}
```

**Option B — Merge into worktree's own base (not main repo HEAD)**

Change `Worktree.merge()` to always `git checkout <this.#base>` (which
it already does) but add a post-merge step to restore the user's
previous branch:

```ts
// After successful merge:
if (prevBranch !== this.#base) {
  try { this.#git('checkout', prevBranch); } catch {}
}
```

**Tests:**
- Main repo on branch B, task base is A → merge blocked with warning
- Main repo on branch A (same as base) → merge succeeds normally
- Post-merge: main repo restored to user's branch (Option B)

---

```
B3 (guard #handleZero)  ←──  depends on  ──→  #tryReconnectWorktree()
        ↑                                            ↑
        │                                            │
B2 (reconnect on pickup) ────── reuses ──────────────┘
        │
        │ (B2 prevents B3, but B3 is the safety net)
        │
B1 (auto-commit) ─── independent ─── can be done in parallel
        │
B6 (branch check) ─── independent ─── can be done in parallel
        │
B5 (stale benchmark) ─── independent ─── 3 layers, can be incremental
        │
B4 (default autoStash) ─── independent ─── trivial
```

**Recommended implementation sequence:**
1. Add `#tryReconnectWorktree()` to Engine + `Worktree.autoCommit()`
2. Implement B3 guard in `#handleZero()` (uses reconnect)
3. Implement B2 reconnect in `tick()` (uses same method)
4. Implement B1 auto-commit in `#runSpawnCycle()` (independent)
5. Implement B6 base-branch check before merge (independent, low)
6. Implement B5 layer 1: crash detection (independent, low complexity)
7. Implement B5 layer 2: no-progress detection (independent)
8. Implement B5 layer 3: baseline regression (independent)
9. Implement B4 default flip (independent, trivial)

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

## Summary

| Bug | Severity | Fix | Files | Complexity |
|-----|----------|-----|-------|------------|
| **B3** | Critical | Guard `#handleZero()` + `#tryReconnectWorktree()` | Engine.ts | Low |
| **B2** | High | Reconnect worktree in `tick()` (reuses B3 method) | Engine.ts | Medium |
| **B1** | High | Auto-commit after agent exits (`Worktree.autoCommit()`) | Engine.ts, Worktree.ts | Low |
| **B5** | High | Crash detection + no-progress tracking + baseline regression | Engine.ts, TaskState.ts, cli.ts | Medium–High |
| **B6** | High | Verify base branch before merge or restore user branch after | Engine.ts, Worktree.ts | Low |
| **B4** | Medium | Default `autoStashBeforeMerge` to true + env var | Engine.ts, env.ts | Low |

### Priority order

1. **B3** — false CONVERGED is the worst outcome.
2. **B2** — every restart wastes progress or triggers B3.
3. **B1** — uncommitted changes create gap between validated and merged code.
4. **B6** — user silently loses branch context on merge.
5. **B5** — stale benchmark burns retries or causes false convergence.
6. **B4** — has working workaround (`autoStashBeforeMerge`).

---

### 🔴 B5: Stale benchmark — unreliable measurement at every phase

**Severity:** High — affects every task with a time gap between creation
and execution  
**Scenarios:** 1.1, 1.2, 1.3, and every subsequent benchmark run  
**Priority:** Fix after B1–B3 (foundational — changes the convergence
model)

**Problem:** The benchmark (`benchmark.js`) is a static artifact written
at task creation time. The codebase evolves between creation and pickup.
The benchmark can become unreliable in both directions:

| Staleness mode | Effect | Example |
|---------------|--------|---------|
| **False negative** | metric > 0 but criteria unreachable. Agent grinds, burns all retries, can never reach 0 | File renamed → benchmark greps for old name → always fails |
| **False positive** | metric = 0 but task isn't done. Task falsely converges | Checked file deleted → grep returns 0 → "pass" |
| **Crash** | Benchmark process error. Caught as metric=1, indistinguishable from real work needed | Stale import → MODULE_NOT_FOUND |
| **Infra regression** | build/test fail on clean base. Agent tries to fix unrelated failures | Another task's merge broke tests |

**Root cause:** The benchmark is a point-in-time artifact in a moving
codebase. There is no freshness check, no validation that the benchmark
still measures what it was designed to measure.

**Current mitigations (partial):**
- `ORCH_VERIFY_CMD` catches some false positives at merge time
- Convergence × 3 requires repeated stable results
- Agent can update `benchmark.js` (prompt allows it)

#### Implementation plan

**Layer 1 — Crash detection** (Low complexity)

Distinguish benchmark crash from legitimate metric > 0.

**File:** `src/cli.ts` — benchmark function (line 297)

When `execFileSync` throws AND `parseMetrics` finds 0 criteria → the
benchmark crashed (no METRIC lines emitted). Return a signal to Engine.

**File:** `src/Engine.ts` — `#run()` and `tick()`

`#run()` returns `{ metric, crashed }`. If crashed on initial check →
release to PENDING with cooldown, log `"benchmark crashed"`, don't
consume retries.

**Layer 2 — No-progress detection** (Medium complexity)

Track pre-agent vs post-agent metric. If unchanged across N consecutive
runs, the benchmark is likely stale.

**File:** `src/TaskState.ts` — add `.stale_count` (non-negative integer
file, like `.convergence_count`)

**File:** `src/Engine.ts` — `#runSpawnCycle()`

After agent runs, compare pre-agent and post-agent metric. If no
improvement → increment `.stale_count`. After threshold (default 2) →
log `"metric unchanged for N runs — benchmark may be outdated"`, release
as FAILED without consuming MAX_FAILURES retries. Reset stale count on
any progress.

**Layer 3 — Baseline regression detection** (Medium complexity)

Save first-run metric results as `.baseline`. On subsequent runs, if a
metric that was 0 at baseline is now > 0, the base regressed — not the
task's fault.

**File:** `src/TaskState.ts` — `.baseline` (JSON file with commit hash +
metric values). Invalidated when `benchmark.js` mtime is newer.

**File:** `src/Engine.ts` — initial check in `tick()`

Compare current metrics against baseline. Regressed metrics → release
to PENDING with cooldown, log clearly.

**Tests for each layer:**
- Crash: process error + 0 METRIC lines → no retry consumed
- No-progress: metric unchanged × N → stale count incremented → threshold → FAILED
- Baseline regression: metric was 0, now > 0 → no retry consumed
- Baseline invalidation: benchmark.js updated → baseline reset

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
