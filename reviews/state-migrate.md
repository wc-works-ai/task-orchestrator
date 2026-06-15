# Review: `src/state/migrate.ts`

`migrate.ts` is generally disciplined and does **not** contain literal monkey-patching. The closest things to quick-fix compatibility shims are intentional migration normalizations: mapping `IN_PROGRESS*` to `FAILED`, coercing unknown statuses to `PENDING`, coercing bad counters to `0`, and dropping invalid dependency entries. Those choices are pragmatic and safer than trying to preserve legacy corruption, but they are still silent data repairs, so they should be treated as migration policy rather than invisible cleanup.

On structure and readability, the file is small, cohesive, and easy to scan. `migrateShards()` owns traversal and per-task isolation, while the helper functions each sanitize one metadata shape. That separation is consistent and keeps the main loop understandable. The comments are also better than average: they explain idempotency, non-migration of claims, and why per-task failures are logged instead of aborting the whole import.

The main correctness risk is not monkey-patching but **silent lossy normalization**. If a legacy task has an unexpected `.status`, malformed counts, duplicate dependencies, or a self-dependency, the import succeeds with sanitized values and no audit trail. That is operationally resilient, but it can hide real historical data problems and make post-migration debugging harder. Similarly, `TASK_DIR` requires `T<number>-<name>` with at least one char of name; any older directory shape outside that pattern is ignored entirely.

Extensibility is decent for the current format, but the implementation is somewhat stringly-typed: shard names, dotfile names, and parsing rules are all embedded inline. If another metadata field or legacy variant appears, the file will still be maintainable, but the policy surface will spread across several helpers. A small central schema/mapping object could make future migrations easier without adding much complexity.

Scalability is fine for the likely workload because this is a one-time startup migration, not a hot path. The synchronous filesystem API is appropriate here. The design principle tradeoff is also sensible: prefer deterministic import and leave directories in place rather than mutating legacy content during migration.

Recommendations:
1. Keep the current compatibility behavior, but emit lightweight warnings for sanitized status/count/dependency cases so bad legacy inputs are observable.
2. Consider deduplicating dependencies and optionally rejecting self-dependencies during import.
3. If legacy formats may vary further, centralize metadata filenames and normalization rules into a small migration policy object.
4. Preserve the current per-task error isolation; that is the strongest design choice in the file and should not be relaxed.

I did not change `src/state/migrate.ts` because I did not identify a clear bug fix worth production changes, and the repo guidance requires test-first changes when behavior is modified.
