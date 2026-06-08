# Testing

## Rules

- **Isolated filesystem** — every test uses `mkdtempSync`, never real files
- **Mock at module boundary** — `vi.mock('node:child_process')`, not internals
- **Test error paths** — every `try/catch`, every `throw`, every `continue`
- **One test file per source file** — `{Module}.test.ts` mirrors `src/`

## AI: before writing tests

1. Read source. Map every branch.
2. For each public method: happy path + edge case + error path.
3. Verify: `npm run tc` — target 80%+ branch coverage.
