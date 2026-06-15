# Review of `src/shared/errors.ts`

`src/shared/errors.ts` is small, cohesive, and notably free of actual monkey-patches: it does not mutate built-ins, rewrite third-party behavior, or hide failures behind silent catch blocks. The closest thing to a quick-fix-looking construct is `syncSleep()` using `Atomics.wait()` on a throwaway buffer. That can look hacky at first glance, but here it is a deliberate, documented consequence of using synchronous `node:sqlite`; it is unusual, not a monkey-patch.

## Assessment

- **Consistency:** The file uses a clear pattern: domain errors inherit from `OrchestratorError`, expose `severity`, and provide an operator-facing `action`. That keeps engine-level handling uniform.
- **Readability:** The comments explain intent well, especially the fatal vs warn split and the retry strategy. `handleOrchestratorError()` and `withRetry()` are short and easy to audit.
- **Extensibility:** Adding another orchestrator-level error is straightforward. The main extension pressure is that severity is binary and hard-coded into subclasses; that is fine today, but future categories might want richer metadata.
- **Correctness:** Mapping SQLite low-byte result codes covers extended BUSY/LOCKED/CORRUPT/NOTADB variants correctly. The main behavioral risk is policy, not mechanics: unknown errors are downgraded to warnings, which preserves loop progress but can also mask repeatable systemic bugs.
- **Scalability:** Blocking exponential backoff is acceptable for the current synchronous DB model, but it stalls the whole process during contention. If concurrency or workload size grows, this design will become a bottleneck.
- **Design principles:** Separation of concerns is good: classification, retry, and operator messaging are centralized instead of scattered through DB callers.

## Recommendations

1. Keep the current structure; it is cleaner than most ad hoc error layers.
2. Consider including `taskId` in formatted log output when present, otherwise the field adds little operator value.
3. Consider named SQLite code constants instead of inline numeric literals to make maintenance easier.
4. Revisit the “unknown error => warning/continue” policy if production experience shows repeated hidden failures; a threshold/escalation path may be safer than always continuing.
5. Keep the `syncSleep()` comment: without that explanation, it is the one area most likely to be mistaken for a quick-fix hack.

Overall, the file is sound, readable, and intentionally designed. Its biggest risk is not monkey-patching or structural inconsistency, but whether the lenient handling of unknown errors hides bugs that should eventually fail fast.
