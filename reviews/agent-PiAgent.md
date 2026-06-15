# Review of `src/agent/PiAgent.ts`

`PiAgent` is functional and well-tested, but it carries several quick-fix heuristics that make the class harder to evolve safely.

## Monkey-patches / quick-fix hacks

1. **Task-script regeneration inside `spawn`** (`#writeAutoresearchScript`, called from `#run`) is effectively a runtime patch: every spawn overwrites `autoresearch.sh` to keep benchmark execution stable. That may be necessary operationally, but it couples the agent implementation to task-file repair and hides a workflow invariant inside a side effect.
2. **Iteration counting by raw substring search** (`ITERATION_MARKER = 'log_experiment'` + `countOccurrences`) is a heuristic, not a semantic signal. It can overcount if that string appears in unrelated output.
3. **Auth detection by regex over raw output** (`AUTH_FAILURE_RE`, `#collectAuthProviders`) is another heuristic. The extra provider-name filter shows the code is already compensating for false positives from test/log text.
4. **Silent JSON parse failure** (`#parseJsonRecord`) is a classic quick fix: malformed lines are discarded with no telemetry, so observability drops exactly when the stream gets weird.

## Assessment

- **Consistency/readability:** Naming is mostly consistent, and the private helper layout is tidy. However, `#run` owns too many concerns at once: CLI spawning, timeout management, process termination, auth detection, NDJSON parsing, token accounting, logging, script generation, and final result synthesis. That makes local reasoning expensive.
- **Extensibility:** Adding new structured events, alternate benchmark protocols, or different retry policies will likely expand `#run` further. The prompt text is also embedded inline, which invites drift versus other agents.
- **Correctness:** The biggest correctness risk is heuristic parsing. Counting literal `log_experiment` strings and inferring auth failures from free-form text are weaker than consuming structured tool events. `task.directory.startsWith(cwd)` in `#prompt` is also path-fragile: sibling prefixes and Windows case differences can produce wrong relative-path decisions.
- **Scalability:** Runtime scalability is fine for one child process, but maintenance scalability is weaker: this class is becoming the catch-all integration layer.
- **Design principles:** The file violates single-responsibility more than anything else. It is not a monkey-patch soup, but it is accumulating operational workarounds.

## Recommendations

1. Split stream parsing/session state from process orchestration.
2. Count iterations from parsed `tool_execution_*` events instead of raw substring matches.
3. Prefer structured auth/error signals over regex scanning, or at least log when heuristic detection is used.
4. Replace `startsWith(cwd)` with a path-safe relative-path check.
5. Move prompt construction to a shared template/builder to reduce duplication and drift.

Overall: good defensive coverage, but the implementation should be refactored before more behavior is added.