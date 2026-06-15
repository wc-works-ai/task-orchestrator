# Review of `src/engine/Worktree.ts`

`Worktree` is compact and readable, and its public API maps cleanly to the engine lifecycle (`create`, `syncWithBase`, `merge`, `cleanWorktree`, `resetForRetry`, `remove`). The naming is consistent, the private field usage matches project conventions, and the integration tests suggest the class already covers many real git scenarios. That said, the file also contains a few operational quick fixes that are worth calling out before more behavior accumulates.

## Monkey-patches / quick-fix hacks

1. **Self-heal retry in `create()`**: on any `worktree add` failure, the class immediately prunes registrations, force-removes the path, and retries once. This is not a monkey-patch in the runtime-object sense, but it is a workflow patch: a broad recovery path that assumes many failures are stale-worktree leftovers.
2. **Silent fallback helpers**: `autoCommit()` uses `catch { return false; }`, `#hasUnmergedPaths()` uses `catch { return false; }`, and `#gitConfig()` uses `catch { return ''; }`. Those are classic quick-fix fallbacks because they collapse very different failure modes into the same result.
3. **Best-effort cleanup everywhere**: many failure paths only warn and continue. That keeps the orchestrator resilient, but it also means some state-restoration failures become easy to miss.

## Assessment

- **Consistency/readability:** The file is short and mostly easy to scan. Helper naming is good. The main readability issue is repeated nested `try/catch` recovery logic in `create`, `syncWithBase`, and `merge`; the intent is sound, but the control flow is dense.
- **Extensibility:** The class mixes several concerns: git command execution, recovery policy, conflict detection, branch restoration, config propagation, and cleanup. If new merge/retry modes appear, this class will likely grow by adding more ad hoc branches.
- **Correctness:** The biggest risk is the silent fallback pattern. For example, `#hasUnmergedPaths()` returning `false` on command failure can misclassify a real git problem as a generic merge error. `autoCommit()` also hides the root cause of commit failures.
- **Scalability:** Runtime scale is probably fine for this tool, but maintenance scale is weaker. More recovery cases will make synchronous, stringly git orchestration harder to reason about.
- **Design principles:** The class is pragmatic, but it leans toward "recover somehow" rather than "surface precise state". That is effective operationally, yet it drifts from the repo's stated preference to avoid quick-fix workarounds and silent error swallowing.

## Recommendations

1. Replace silent fallbacks with explicit logging that preserves the command/context, especially in `autoCommit`, `#hasUnmergedPaths`, and `#gitConfig`.
2. Extract repeated merge/restore/abort sequences into small private helpers so recovery policy is centralized instead of duplicated.
3. Narrow the `create()` self-heal retry to known stale-worktree signatures if possible, rather than treating every add failure the same way.
4. Consider separating low-level git command execution from higher-level recovery policy to keep the class easier to extend and test.

Overall: solid operational utility and decent structure, but the file does contain quick-fix recovery patterns that should be tightened before the next round of behavior is added.
