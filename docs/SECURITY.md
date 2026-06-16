# Security review

This review covers the runtime code under `src/**` plus the dependency graph in `package.json` / `package-lock.json`.

## Summary

Two changes were made as part of this audit:

1. **Dependency fix:** pinned transitive `esbuild` to `0.28.1` via `package.json` `overrides` and refreshed `package-lock.json` so `npm audit` reports **0 moderate-or-higher vulnerabilities**.
2. **Path-safety hardening:** replaced string-prefix prompt path detection in `PiAgent` and `CopilotAgent` with a real relative-path check (`src/agent/taskPromptPath.ts`). This avoids misclassifying sibling paths such as `C:\repo` vs `C:\repo2`.

## Findings by category

### 1. Dependency vulnerabilities

**Finding:** `npm audit` reported one high-severity transitive vulnerability in `esbuild` (`< 0.28.1`).

**Action taken:** added:

```json
"overrides": {
  "esbuild": "0.28.1"
}
```

and regenerated `package-lock.json`.

**Result:** `npm audit --audit-level=moderate` now reports `0 vulnerabilities`.

### 2. Command / shell injection

**Reviewed surfaces:**
- `src/cli.ts`
- `src/engine/Engine.ts`
- `src/engine/Worktree.ts`
- `src/state/addTask.ts`
- `src/agent/cliCommand.ts`
- `src/agent/PiAgent.ts`
- `src/agent/CopilotAgent.ts`
- `src/agent/ExecAgent.ts`

**Findings:**
- Normal production subprocess usage already prefers `execFileSync` / `spawn` with explicit argument arrays for `git`, `node`, `pi`, `copilot`, `where.exe`, and `taskkill`.
- `ExecAgent` intentionally uses `spawn(cmd, { shell: true })` for `ORCH_AGENT_CMD`. That is a **trusted local configuration surface**, not user/task content. It exists to run a deliberately operator-supplied shell command.
- `Engine.#runVerifyCmd()` intentionally uses `cmd /c` / `sh -c` for `ORCH_VERIFY_CMD`. This is also a **trusted local configuration surface** and is documented in `docs/ENV_VARS.md` as a shell command.
- `addTask()` writes a benchmark scaffold that contains `execSync(command)`, but that scaffold lives in task content, not orchestrator runtime code, and is expected to execute user-authored benchmark commands.

**Action taken:** no runtime shell-injection bug was found in the orchestrator code paths. No code change was needed beyond documenting this review here.

### 3. SQL injection

**Reviewed areas:** `src/state/TaskDb.ts`, `src/state/sqlite.ts`, tests that exercise query behavior.

**Findings:**
- Normal reads/writes use parameterized queries (`?` / `:name`) throughout `TaskDb`.
- Dynamic `IN (...)` placeholder generation in `byStatus()` only interpolates placeholder tokens, not external values.
- `VACUUM INTO` in `TaskDb.backup()` is the only intentionally dynamic SQL string. The destination path is escaped with `toPath.replace(/'/g, "''")`, which is the required SQLite single-quote escaping for string literals.

**Action taken:** no SQL injection issue found.

### 4. Path traversal

**Reviewed areas:** task names, task directories, repo/state/worktree paths, prompt path construction.

**Findings:**
- `addTask()` rejects task names containing path separators, `..`, Windows-reserved metacharacters, or leading/trailing whitespace.
- `resolveAddRepo()`, `resolveStatePaths()`, and `repoSlug()` normalize paths through `resolve()` and sanitize derived slug values.
- `Worktree` paths are derived from validated task names and fixed orchestrator-controlled prefixes.
- Benchmark execution uses `process.execPath` plus a resolved `benchmark.js` path rather than a shell command.
- **Issue found:** `PiAgent` and `CopilotAgent` previously used `task.directory.startsWith(cwd)` to decide whether to show a relative task path in prompts. That is path-fragile because a sibling path can share a string prefix without being inside the worktree.

**Action taken:** fixed by introducing `src/agent/taskPromptPath.ts`, which uses `path.relative()` and rejects parent/sibling escapes.

### 5. ReDoS

**Reviewed regexes:** task-dir parsing, metric extraction, prompt metadata parsing, auth detection, Windows shim parsing, repo slug cleanup, merge-lock metadata parsing.

**Findings:**
- The regexes are simple anchored patterns or bounded character classes.
- No nested catastrophic-backtracking patterns were found on attacker- or agent-controlled input.
- The longest multiline markdown-section regexes operate on local task files, not unbounded network input, and do not contain the usual catastrophic structures.

**Action taken:** no ReDoS issue found.

### 6. Secret / credential handling

**Findings:**
- No hardcoded API keys, tokens, or credentials were found in `src/**`.
- Auth discovery for Pi/Copilot checks environment variables (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN`) or local CLI auth state.
- The orchestrator logs only generic auth status messages; it does not print secret env var values.
- `ExecAgent` and `PiAgent`/`CopilotAgent` pass `process.env` through to child processes, which is expected so local tools can authenticate. As always, child process output itself may contain whatever that child decides to print.

**Action taken:** no hardcoded-secret issue found.

### 7. Prototype pollution / unsafe parsing

**Reviewed parses:**
- `src/agent/PiAgent.ts`
- `src/shared/BenchmarkMeta.ts`
- `src/shared/version.ts`

**Findings:**
- Parsed JSON is treated as data, not merged into live config/prototype-bearing objects.
- `PiAgent` gates parsed values through `#record()` and explicit numeric extraction before use.
- No unsafe recursive merge / `Object.assign` path from untrusted JSON into application objects was found.

**Action taken:** no prototype-pollution issue found.

## Validation

- `npm audit --audit-level=moderate` → passes with 0 vulnerabilities
- `npm run c` → passes
- `npm run test:unit` → passes
- `npm run tc` → passes

## Residual risk notes

- `ORCH_AGENT_CMD` and `ORCH_VERIFY_CMD` are intentionally shell-capable and should be treated as **trusted local operator configuration**, not untrusted task input.
- Raw agent logs (`ORCH_AGENT_LOG_RAW=1`) can record verbatim child-process output; that is operationally useful but means downstream tools should avoid printing secrets to stdout/stderr.
