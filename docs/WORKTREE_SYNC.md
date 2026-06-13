# Worktree synchronization

How the orchestrator manages git worktrees across task lifecycles,
process restarts, and concurrent operations.

Each scenario is labeled: ✅ **safe**, ⚠️ **risk**, or 🔴 **problem**.

---

## 1. Architecture

Each task gets its own git worktree on a branch `orchestrator/<taskName>`,
created from the task's **target branch** (recorded in `.target_branch`
at task creation time).

| Component | Location | Persistence |
|-----------|----------|-------------|
| Main repo | The checkout the orchestrator runs in | Permanent |
| Worktree | `<worktreesDir>/<taskName>` | Survives restarts; deleted on convergence |
| Target branch | `.target_branch` file in task directory | On disk (survives restart) |
| Worktree map | `Engine.#worktrees` (in-memory Map) | **Lost on restart** — reconnected via B2 fix |
| Convergence count | `.convergence_count` file in task directory | On disk (survives restart) |
| Agent commits | On worktree branch + auto-committed by orchestrator | On git branch |

### Key behaviors

- **Target branch** is captured per-task at creation time, not per-Engine.
  Different tasks can target different branches.
- **Worktrees are created lazily** — only when metric > 0 and `.git`
  exists (inside `#prepareWorktree()`).
- **Agent work is auto-committed** after the agent exits and before the
  benchmark runs (`Worktree.autoCommit()`). This ensures merge captures
  exactly what the benchmark validated.
- **Auto-stash is on by default** — main repo uncommitted changes are
  stashed before merge. Disable with `ORCH_AUTO_STASH=false`.
- **Worktree reconnection** — on process restart, if convergenceCount > 0,
  the orchestrator attempts to reconnect to the existing worktree on disk.

---

## 2. What is guaranteed

These work correctly today:

| Area | Why |
|------|-----|
| **Parallel ticks (same process)** | `#owned` Set prevents duplicate processing |
| **Parallel orchestrators** | Claims (`.claim/`) prevent duplicate pickup; merge lock prevents concurrent merge |
| **Cross-task isolation** | Each task has its own worktree and branch |
| **Branch reuse on restart** | `#add()` reuses existing branch; `cleanWorktree()` only removes uncommitted changes |
| **Recovery preserves convergence** | `#recover()` releases stale claims → FAILED but does NOT reset convergence |
| **`--unblock` resets task state** | Clears failures/convergence/claim → PENDING; worktree and branch preserved |
| **Convergence counter corruption** | Missing/unreadable file → treated as 0; no crash |
| **Scope enforcement** | Advisory only (prompt-based); out-of-scope edits handled by git conflicts |
| **`node_modules` copy failure** | Best-effort; failure → benchmark failure → natural retry |
| **Dependencies** | Wait for CONVERGED status, not convergence count |
| **Non-git repo** | Orchestrator degrades to simple benchmark loop; warned in log |
| **Auto-commit** | `Worktree.autoCommit()` after agent exits; merge captures validated code |
| **Target branch** | Per-task `.target_branch`; merge always goes to correct branch |
| **Auto-stash** | Default on; main repo dirty files stashed before merge |
| **Worktree reconnection** | On restart with convergence > 0, reconnects from disk or resets convergence |

---

## 3. Lifecycle scenarios

### 3.1 First pickup (PENDING → IN_PROGRESS)

No worktree exists yet. Benchmark runs against main repo.

| # | Scenario | Status |
|---|----------|--------|
| 1.1 | metric > 0 → create worktree, spawn agent | ✅ |
| 1.2 | metric = 0 → convergence starts (no worktree needed) | ✅ |
| 1.3 | Benchmark crashes (process error) | ⚠️ Agent spawned against broken benchmark |

**Note:** The benchmark may be outdated at pickup time — see §5.

### 3.2 Agent works (worktree active)

Worktree created, agent spawned with `cwd = worktree`.

| # | Scenario | Status |
|---|----------|--------|
| 2.1 | Agent commits, metric = 0 → convergence starts | ✅ |
| 2.2 | Agent commits, metric > 0 → FAILED → retry resets worktree to base (by design) | ✅ |
| 2.3 | Agent leaves uncommitted changes → auto-committed before benchmark | ✅ |
| 2.4 | Agent crashes mid-work → auto-commit captures whatever was written | ✅ |
| 2.5 | Main repo advances while agent works → synced at next `#prepareWorktree` or merge | ✅ |
| 2.6 | `syncWithBase()` fails during `#prepareWorktree()` → `resetForRetry()` (hard reset to base) | ⚠️ All agent commits on branch are lost |
| 2.7 | `cleanWorktree()` fails silently → agent starts on dirty worktree | ⚠️ Errors swallowed, not logged |
| 2.8 | Agent edits files outside scope → committed, may conflict at merge | ⚠️ Prompt-based scope only |

### 3.3 Convergence ticks (convergence 1 → 2 → threshold)

Benchmark re-runs to confirm stability. No cleanup, no sync.

| # | Scenario | Status |
|---|----------|--------|
| 3.1 | Same process, worktree in memory, metric = 0 | ✅ |
| 3.2 | Same process, metric > 0 (regression) → convergence resets, agent retries | ✅ |
| 3.3 | Base advanced between ticks → worktree stale; caught at merge (sync + re-benchmark) | ⚠️ Wastes convergence ticks if merge will rework |
| 3.4 | Process restarted, convergence > 0 → worktree reconnected from disk | ✅ |
| 3.5 | Process restarted, worktree gone → convergence reset to 0 | ✅ |

### 3.4 Merge (convergence = threshold)

| # | Scenario | Status |
|---|----------|--------|
| 4.1 | Clean merge | ✅ |
| 4.2 | Main repo dirty → auto-stashed before merge | ✅ |
| 4.3 | Base advanced, no conflicts → sync succeeds, merge succeeds | ✅ |
| 4.4 | Base advanced, sync conflicts → BLOCKED, branch kept | ✅ |
| 4.5 | Re-benchmark fails after sync → rework (convergence reset) | ✅ |
| 4.6 | verifyCmd fails → rework | ✅ |
| 4.7 | Merge conflict (branch → base) → BLOCKED, branch kept | ✅ |
| 4.8 | Another orchestrator holds merge lock → retry next tick | ✅ |
| 4.9 | SIGKILL during merge → repo left on base branch, lock remains | ⚠️ Needs manual cleanup; lock auto-reclaimed after timeout |
| 4.10 | SIGKILL during syncWithBase → `resetForRetry()` wipes commits | ⚠️ Silent data loss |
| 4.11 | Successful merge leaves main repo on target branch | 🔴 **Problem P1** |
| 4.12 | Auto-stash is never restored after merge | 🔴 **Problem P2** |

### 3.5 Failure and retry

| # | Scenario | Status |
|---|----------|--------|
| 5.1 | Same process → `resetForRetry()` + clean + sync. Fresh start from base | ✅ By design |
| 5.2 | Process restarted → worktree reused from existing branch. Clean + sync | ✅ |
| 5.3 | Sync conflicts on retry → `resetForRetry()` wipes branch commits | ⚠️ Agent work lost; starts fresh |
| 5.4 | Task blocked (MAX_FAILURES) → worktree/branch preserved | ✅ |

### 3.6 Recovery and special operations

| # | Scenario | Status |
|---|----------|--------|
| 6.1 | Stale claim recovery (owner crashed) → FAILED, convergence preserved | ✅ |
| 6.2 | `--unblock` → resets state, preserves worktree/branch | ✅ |
| 6.3 | `--stop` mid-convergence → convergence persists, worktree untouched | ✅ |
| 6.4 | EXDEV shard move → non-atomic copy fallback | ⚠️ Duplicate possible on crash |

### 3.7 Multiple orchestrators

| # | Scenario | Status |
|---|----------|--------|
| 7.1 | Both pick same task → claim is atomic | ✅ |
| 7.2 | Orchestrator A dies, B reclaims → committed work survives, uncommitted auto-committed | ✅ |
| 7.3 | Concurrent merges → merge lock serializes | ✅ |
| 7.4 | Convergence counter race → one count lost at most (bounded) | ⚠️ Non-critical |

### 3.8 node_modules

| Failure mode | Status |
|-------------|--------|
| Copy fails (ENOSPC, EACCES) → silent, benchmark may fail | ⚠️ |
| `npm install` between convergence ticks → worktree uses stale copy | ⚠️ |
| Package removed → worktree retains orphan | ⚠️ |

---

## 4. Current problems

### 🔴 P1: Successful merge leaves main repo on target branch

After `Worktree.merge()` succeeds, the main repo is left checked out on
the task's target branch — not restored to whatever branch the user had.
`prevBranch` is captured but only restored on failure, not on success.

**Impact:** User's branch context is silently changed after each merge.

**Location:** `Worktree.ts:103-123` — `merge()` does
`git checkout base` + `git merge --no-ff` but no checkout-back on
success.

**Fix:** After successful merge, restore `prevBranch`:
```ts
// After line 123 in merge():
if (prevBranch !== this.#base) {
  try { this.#git('checkout', prevBranch); } catch {}
}
```

### 🔴 P2: Auto-stash is never restored after merge

`stashParentChanges()` runs `git stash push` but there is no
corresponding `git stash pop` anywhere. The user's uncommitted changes
remain in the stash indefinitely.

**Impact:** User loses uncommitted work (it's in stash but not restored).

**Location:** `Engine.ts:416-419` calls `wt.stashParentChanges()`.
`Worktree.ts:125-129` does `git stash push`. No `pop`/`apply` anywhere
in the codebase.

**Fix:** After successful merge in `#mergeAndRemove()`, pop the stash:
```ts
// After wt.merge() succeeds:
try { execFileSync('git', ['stash', 'pop'], { cwd: this.#repo }); } catch {}
```

### 🔴 P3: Stale benchmark (B5)

The benchmark is a static artifact written at task creation time. By
pickup time, the codebase may have changed enough to make the benchmark
unreliable in both directions:

| Mode | Effect |
|------|--------|
| False negative | Criteria unreachable → agent burns retries |
| False positive | Check is a no-op → false convergence |
| Crash | Missing imports → agent spawned against broken benchmark |
| Infra regression | Another merge broke build/test |

**Planned fix (3 layers):**
1. Crash detection — process error + 0 METRIC lines → skip, no retry
2. No-progress detection — metric unchanged × N runs → stop retrying
3. Baseline regression — metric was 0 at creation, now > 0 → skip

### ⚠️ P4: cleanWorktree does not clear staged changes

`cleanWorktree()` runs `git checkout -- .` (tracked files) and
`git clean -fd` (untracked files) but does NOT run `git reset HEAD`
(staged changes). A reused worktree can carry staged edits from a
prior run into the next agent session.

**Location:** `Worktree.ts:132-138`

**Fix:** Add `git reset HEAD` before checkout:
```ts
try { this.#gitInWT('reset', 'HEAD'); } catch {}
```

---

## 5. Fixed issues (history)

These were identified during the worktree sync audit and have been
resolved:

| ID | Problem | Fix | Commit |
|----|---------|-----|--------|
| B1 | Uncommitted agent changes lost at merge | `Worktree.autoCommit()` before benchmark | `3ab1b3c` |
| B2 | Process restart loses worktree reference | `#tryReconnectWorktree()` at pickup | `e431946` |
| B3 | Convergence without merge (orphaned branch) | Guard in `#handleZero()` + reconnect | `96b80f9` |
| B4 | Main repo dirty blocks merge | Default `autoStashBeforeMerge` to true | `e431946` |
| B6 | Merge into wrong branch after user switches | `.target_branch` per task | `9ba9f7c` |

---

## Appendix: What --unblock resets

| State | Reset? | Detail |
|-------|--------|--------|
| `.status` | ✅ | → PENDING |
| `.failure_count` | ✅ | → 0 |
| `.convergence_count` | ✅ | → 0 |
| `.claim` directory | ✅ | removed |
| `.target_branch` | ❌ | preserved (same target) |
| Worktree directory | ❌ | preserved |
| Git branch | ❌ | preserved (commits survive) |
| Agent logs | ❌ | preserved |

**Note:** After unblock, `#prepareWorktree()` reuses the existing
branch. Conflict-causing commits from the original failure are still on
the branch — the same conflict may recur. For a fresh start:
`git worktree remove --force .worktrees/<name>` and
`git branch -D orchestrator/<name>` before unblocking.
