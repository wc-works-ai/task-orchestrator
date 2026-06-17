# Review of `src/state/TaskDb.ts`

`TaskDb` is mostly strong code: the class has a clear boundary, the public API is grouped by lifecycle, and the claim-gated methods make ownership rules easy to reason about. I do **not** see literal monkey-patching here, which is good. The quick-fix pressure shows up instead in a few defensive shortcuts and implicit contracts.

## Monkey-patches / quick-fix hacks

1. **Depth-capped recursive blocking** (`MAX_DEPENDENCY_DEPTH`) is a pragmatic safety rail, not a root-cause fix. It prevents runaway recursion, but it also means malformed dependency cycles are tolerated and partially masked instead of being rejected at write time.
2. **`backup()` deletes the destination first** because `VACUUM INTO` needs a non-existent file. That is a reasonable SQLite workaround, but it is still an operational hack living in the domain class.
3. **`byStatus()` relies on an undocumented runtime precondition** that `statuses` is non-empty. The comment says callers obey it, but the method does not enforce it. That is brittle because an empty list would generate `IN ()` SQL.
4. **`release()` accepts any `TaskStatus`** even though the comment describes terminal transitions. That mismatch is a design shortcut: correctness depends on callers not passing an inappropriate status.

## Assessment

- **Consistency/readability:** Sectioning and naming are good, and the SQL is short enough to follow. The file is dense but still navigable.
- **Extensibility:** The class remains cohesive around persistence, but schema ownership, lifecycle rules, stale recovery, cascading, and backup are all accumulating here. Future features may make it a hotspot.
- **Correctness:** Claim-gated updates are the strongest part of the design. The main risks are implicit invariants: DAG-shaped dependencies, non-empty `byStatus()` inputs, and caller-disciplined status transitions.
- **Scalability:** Runtime scalability is acceptable for SQLite orchestration workloads. Maintenance scalability is the larger concern because rules are encoded across many SQL snippets instead of a smaller set of transition helpers.
- **Design principles:** This is not hacky overall, but it would benefit from moving from “defensive limits and caller discipline” toward “validated invariants at the boundary.”

## Recommendations

1. Reject dependency cycles during `insert()` / `importTask()` instead of relying on `MAX_DEPENDENCY_DEPTH`.
2. Make `byStatus([])` fail fast or return `[]` explicitly.
3. Narrow `release()` to the allowed terminal statuses, or validate the input before issuing SQL.
4. If backup behavior is reused elsewhere, extract/document the SQLite-specific file replacement rule so `TaskDb` stays focused on task state.
