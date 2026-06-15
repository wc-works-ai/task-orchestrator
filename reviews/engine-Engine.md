# Review of `src/engine/Engine.ts`

`Engine` is ambitious and broadly capable, but it has grown into a high-responsibility coordinator that mixes queue selection, benchmark execution, agent spawning, worktree lifecycle, merge recovery, retry policy, reconciliation, stop handling, and logging in one class. I do not see literal runtime monkey-patching, which is good, but I do see several **quick-fix style operational fallbacks** that reduce clarity and make future change riskier.

## Monkey-patches / quick-fix hacks

The main “hacky” areas are defensive fallbacks rather than monkey-patches:

- `#detectBaseBranch()` silently falls back to `'master'` on any git error. That keeps the process alive, but it can mask configuration/repository problems and send work onto the wrong base branch.
- `#prepareWorktree()` copies the entire `node_modules` tree into each worktree. The comment explains why symlinks were avoided, but this is still an expensive workaround that may hurt large repos and parallel execution.
- `#tryReconnectWorktree()` and the extra safety-net reconnection in `#handleZero()` are pragmatic restart repairs, but they indicate lifecycle responsibility is spread across multiple phases instead of being modeled explicitly.
- `parallel === 0 ? 100 : parallel` is a policy shortcut: “unlimited” is not truly unlimited, just capped heuristically.
- Several broad `catch` blocks convert failures into defaults (`'master'`, `false`, benchmark crash, sync reset). That improves resilience, but some branches blur the difference between expected operational states and genuine defects.

## Consistency and readability

The file is internally documented and naming is mostly clear, but the class is too large for easy local reasoning. Many methods are individually understandable, yet the overall control flow is hard to hold in memory because state transitions, side effects, and infrastructure concerns are interleaved. The logging style is consistent, but decisions are often expressed as free-form strings rather than structured outcomes, which makes reasoning and testing more indirect.

## Extensibility

Extending this class will be increasingly difficult because most new behavior naturally lands in `Engine`. The constructor already accepts many options, and private methods cover several domains that could evolve independently. A better boundary would separate:

1. task scheduling/claiming,
2. benchmark evaluation/error classification,
3. agent/worktree execution,
4. merge/sync/verification,
5. startup reconciliation.

That would reduce coupling and make targeted changes safer.

## Correctness

The design shows care around stale claims, merge locking, convergence tracking, and benchmark defect handling. Those are strong points. The main correctness concern is silent fallback behavior: when git state, worktree state, or verification steps fail, the engine often chooses a recovery path without preserving enough structured context. That can make root-cause diagnosis harder and may hide wrong-branch or wrong-environment behavior until later.

## Scalability

Parallel ticks and worktree reuse are good ideas, but copying `node_modules` per worktree is the biggest scalability concern. In a larger repo or with higher `parallel`, disk churn and setup time may dominate useful work. Repeated full scans of task state for idle logging, exhaustion blocking, and owned-task continuation are probably acceptable at small scale but may become a bottleneck as task counts grow.

## Design principles

The class is practical and cohesive at the product level, but it stretches single-responsibility noticeably. It depends on useful abstractions (`BenchmarkFn`, `SpawnFn`, `TaskDb`), which is good, yet still performs a lot of direct filesystem and process orchestration itself. The result is a capable but heavy orchestrator core.

## Recommendations

1. Extract worktree/merge handling into a dedicated collaborator.
2. Extract benchmark-result classification so crash/no-metric/ok logic is centralized and typed.
3. Replace silent fallback-to-`master` with explicit warning/error reporting and a narrower fallback policy.
4. Replace `node_modules` copying with a cheaper root-cause solution if possible, or at least isolate that strategy behind an interface.
5. Convert key free-form recovery decisions into structured result objects/enums to improve maintainability and tests.

Overall: solid operational intent, no literal monkey-patching, but several resilience-oriented shortcuts should be tightened before the class grows further.