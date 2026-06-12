# Testing

## Rules

- **Isolated filesystem** — every test uses `mkdtempSync`, never real files
- **Mock at module boundary** — `vi.mock('node:child_process')`, not internals
- **Test error paths** — every `try/catch`, every `throw`, every `continue`
- **One test file per source file** — `{Module}.test.ts` mirrors `src/`

## Coverage Enforcement

**100% code coverage is a non-negotiable merge gate.** The orchestrator enforces this via:

- **vitest config**: `thresholds` set to 100 for lines, statements, branches, functions
- **npm run tc**: runs tests with coverage and fails if any metric drops below 100%
- **ORCH_VERIFY_CMD**: every task must pass `npm run tc` before merging to the base branch

This is not optional. If your changes reduce coverage, the task will be sent back for rework. This catches:
- Untested error paths
- Dead code paths in recent changes
- Incomplete feature implementations
- Unnecessary complexity

Before committing, run `npm run tc` and verify all metrics are at 100%.

## AI: before writing tests

1. Read source. Map every branch.
2. For each public method: happy path + edge case + error path.
3. Verify: `npm run tc` — 100% branch coverage (enforced by vitest config).
