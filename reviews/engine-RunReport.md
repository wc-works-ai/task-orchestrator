# Review of `src/engine/RunReport.ts`

I do not see any monkey-patching in this module. It does not modify globals, prototypes, imported modules, process state, or runtime behavior outside its own reporting functions. I also do not see an obvious emergency quick-fix hack. The only comment that reads like a defensive workaround is the repeated fallback assumption that any non-failed/non-blocked/non-pending task coming from `TaskState.scan()` must be `IN_PROGRESS`. That is currently true because `scan()` only returns `PENDING`, `IN_PROGRESS`, `FAILED`, and `BLOCKED`, but the assumption is duplicated in `countTasks()`, `taskIcon()`, and `taskStatus()`, so it is a maintenance hotspot rather than a hack.

Structurally, the file is small, readable, and easy to follow. Separating formatting (`formatOverview`, `formatRunSummary`) from output (`printOverview`, `printRunSummary`) is a good design choice, and the helper functions keep the public functions concise. The code is also consistent with the current domain model: converged tasks are counted separately while the live scan focuses on actionable/non-terminal tasks.

Main strengths:
- **Consistency/readability:** simple straight-line logic, predictable output, clear naming.
- **Correctness today:** the implementation matches the documented `TaskState.scan()` contract and has focused unit tests.
- **Extensibility at small scale:** adding another report line or count is easy.

Main risks / recommendations:
1. **State mapping is duplicated.** Status-to-count/icon/text logic is spread across multiple helpers. If a new status is added, it is easy to update one place and forget another. A single status-descriptor helper would reduce drift.
2. **Consistency under concurrent updates is only best-effort.** Each formatter opens the DB, reads non-converged tasks, then separately counts converged tasks. If the DB changes between those reads, the header can reflect a slightly different snapshot than the task list. That is probably acceptable for CLI status output, but if strict snapshot consistency matters, both values should come from one query boundary.
3. **Scalability is acceptable but not ideal.** Every overview/summary call opens and closes the DB and rescans tasks. Fine for a CLI and current scale, but potentially noisy if status output becomes more frequent or task counts grow significantly.
4. **Design contract is implicit.** The fallback-to-`IN_PROGRESS` behavior depends on `TaskState.scan()` filtering. That dependency should remain explicitly documented, or better, encoded through a shared representation so reporting logic does not rely on scattered assumptions.

Overall assessment: this is a clean, modest reporting module with no monkey-patches and no obvious hacky repair code. The main improvement area is not behavior but making the status mapping more single-sourced so future state-model changes cannot silently desynchronize counts, icons, and labels.