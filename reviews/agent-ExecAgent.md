# Review of `src/agent/ExecAgent.ts`

`ExecAgent` is small, readable, and much less workaround-heavy than `PiAgent`. I do **not** see monkey-patches in the classic sense, and there is no obvious “quick fix piled on quick fix” smell in the core control flow. The class is mostly a thin adapter from orchestrator state to `child_process.spawn`, which is good for consistency and maintainability. That said, there are a few lightweight operational shortcuts worth calling out.

## Monkey-patches / quick-fix hacks

1. **Best-effort log writing with a catch-and-console fallback** in `#append` is a deliberate operational compromise. It is acceptable, but it does mean logging failures are suppressed from the returned `SpawnResult`, so observability depends on stderr rather than structured state.
2. **`shell: true` with a raw command string** is a convenience shortcut. It keeps the agent deterministic and simple, but it pushes quoting, shell semantics, and platform differences into runtime behavior instead of modeling command/args explicitly.
3. **Abort handling via `child.kill()` only** is another pragmatic shortcut. With `shell: true`, killing the shell does not always guarantee cleanup of grandchildren on every platform, so this may be slightly weaker than it looks.

## Assessment

- **Consistency/readability:** Strong. The file is short, naming is consistent, and `checkPrerequisites()` / `spawn()` are easy to follow.
- **Extensibility:** Reasonable for the current scope, but limited if exec-mode ever needs richer process control, structured progress events, or token/iteration accounting beyond the fixed `iterations: 1`.
- **Correctness:** The main risk is prerequisite validation being shallow: a non-empty `ORCH_AGENT_CMD` can still be invalid. Abort semantics under `shell: true` are the other notable edge.
- **Scalability:** Runtime scalability is fine because the class does very little. Maintenance scalability is also good as long as it stays a thin adapter and does not absorb special cases.
- **Design principles:** This is mostly sound single-responsibility design. It delegates log truncation to `AgentLog` and config parsing to shared helpers instead of monkey-patching behavior locally.

## Recommendations

1. Keep the class thin; resist adding task-specific repair logic here.
2. If exec-mode grows, prefer a structured command/args model over `shell: true`.
3. Consider stronger prerequisite validation or clearer failure messaging for missing executables.
4. If abort reliability becomes important, revisit process-tree termination behavior per platform.

Overall: clean and restrained implementation, with only a few pragmatic shortcuts rather than true monkey-patch debt.
