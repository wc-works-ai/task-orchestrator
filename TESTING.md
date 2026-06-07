# Testing Conventions

## File naming
`tests/{Module}.test.ts` — one file per source module. Mirror `src/` structure.

## Structure
```ts
describe('ModuleName', () => {
  // Per-test isolation
  let dir: string;
  beforeEach(() => { dir = mkdtempSync('/tmp/test-')); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // Group by method
  describe('methodName', () => {
    it('happy path', () => { /* arrange → act → assert */ });
    it('edge case', () => {});
    it('error path', () => {});
  });
});
```

## Rules
- **Arrange-Act-Assert** — three sections, blank line between
- **One assertion per test** — test one behavior, not multiple
- **Isolated filesystem** — every test uses `mkdtempSync`, never touches real files
- **No shared state** between tests — reset in `beforeEach`
- **Mock at module boundary** — `vi.mock('node:child_process')`, not internal functions
- **Test error paths** — every `try/catch`, every `throw`, every `continue`

## Naming
```
it('returns null when nothing actionable')    // verb + condition
it('throws on invalid status')                 // behavior
it('converges after threshold zero-runs')     // state change
```

## AI instructions
When writing tests for new code:
1. Read the source file first — understand every branch
2. For each public method, test: happy path, edge case, error path
3. For each conditional branch, add a test
4. Use `vi.fn()` for callbacks, `vi.mock()` for modules
5. Verify with `npm run tc` — target 80%+ branch coverage
