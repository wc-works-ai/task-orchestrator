# Testing

## Rules

- **Isolated filesystem** — every test uses `mkdtempSync`, never real files
- **Mock at module boundary** — `vi.mock('node:child_process')`
- **Test error paths** — every `try/catch`, `throw`, `continue`
- **One test file per source file** — `{Module}.test.ts` mirrors `src/`

## Coverage enforcement

**100% code coverage is a non-negotiable merge gate:**
- vitest config: `thresholds` set to 100
- `npm run tc` — runs tests + coverage; fails if any metric drops below 100%
- Every task must pass `npm run tc` before merge

If coverage drops, the task goes back for rework. This catches untested error paths, dead code, and incomplete features.

Before committing: run `npm run tc` and verify all metrics are at 100%.

## Before writing tests

1. Read source. Map every branch.
2. For each public method: happy path + edge case + error path.
3. Run `npm run tc` — verify 100% branch coverage.

