# Review: `src/state/Status.ts`

`Status.ts` is small and readable, and I do **not** see any literal monkey-patch here. The only thing that feels like a quick-fix-style compromise is the `IN_PROGRESS:${id}` encoding: it mixes status and owner metadata into a single string instead of keeping the canonical state separate from the claimant. That works today, but it is a stringly-typed shortcut that leaks into helpers such as `isInProgress()` and forces downstream code to accept `Status | string` instead of a tighter domain type.

## Assessment

- **Consistency:** Mostly consistent for terminal/actionable states, but `IN_PROGRESS` is modeled differently from every other status.
- **Readability:** Very easy to scan; the file is minimal. The main hidden behavior is that `CONVERGENCE_THRESHOLD` and `MAX_FAILURES` snapshot environment-derived values at module load.
- **Extensibility:** Adding a new plain status is easy, but adding any status-with-metadata repeats the same ad hoc string encoding problem.
- **Correctness:** `isInProgress()` uses `startsWith('IN_PROGRESS')`, which is permissive and would also accept malformed values such as `IN_PROGRESS_BOGUS`. The frozen config exports can also surprise tests or long-lived processes if env is expected to stay lazy elsewhere.
- **Scalability:** Runtime cost is trivial; the bigger scaling risk is conceptual drift as more callers depend on string conventions.
- **Design principles:** The file is simple, but it blends three concerns: canonical status values, derived status-string formatting, and configuration reads.

## Recommendations

1. Introduce a dedicated type for runtime task state, e.g. `Status | \`IN_PROGRESS:${string}\`` or, better, a structured view object so ownership is not embedded in the status token.
2. Define a shared `IN_PROGRESS_PREFIX = 'IN_PROGRESS:'` and use it in both formatter and parser to avoid drift.
3. Tighten `isInProgress()` to the exact prefix contract, unless backward compatibility intentionally requires looser matching.
4. Move config snapshots out of this status module, or export getters/functions instead of import-time constants, so environment handling stays consistent with the lazy `env` design used elsewhere.
