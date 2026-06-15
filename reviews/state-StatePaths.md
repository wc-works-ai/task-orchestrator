# Review of `src/state/StatePaths.ts`

`StatePaths.ts` is a small, disciplined helper module. It does **not** look like a monkey-patch sink or a quick-fix accumulation point; the file is short, pure, and easy to follow. The main logic is a straightforward transformation from user inputs to canonical absolute paths.

## Monkey-patches / quick-fix hacks

I do not see any obvious monkey-patches in this file. There are, however, two small convenience shortcuts that are worth treating carefully:

1. **Falsy-coalescing for path inputs** (`inputs.stateRoot || defaultStateRoot()`, and similarly for `tasks` / `worktrees`) treats an explicit empty string the same as “not provided”. That is pragmatic, but it is also a mild shortcut instead of explicit validation.
2. **`repoSlug()` is intentionally lightweight.** It sanitizes invalid filename characters and trims trailing dots, but it does not try to guarantee uniqueness, normalize case, or defend against every platform-specific edge case. That is acceptable today, but it is a deliberately narrow policy rather than a comprehensive naming model.

## Assessment

- **Consistency:** Very consistent. The file uses one clear pattern: normalize inputs early, then derive outputs once.
- **Readability:** Excellent. The naming is direct, the interfaces are small, and each function does one thing.
- **Extensibility:** Reasonable for current scope, though more path rules would quickly pressure `repoSlug()` into becoming a policy hotspot.
- **Correctness:** Good for normal usage. The main subtle risk is slug stability/collision behavior: repositories that differ only by case or sanitize to the same slug could map into the same state area on case-insensitive systems.
- **Scalability:** Runtime scalability is a non-issue because the work is trivial. Maintenance scalability is also good while the module stays focused.
- **Design principles:** Strong SRP. This file is a clean boundary for path derivation and is much sounder than scattering path assembly through the CLI.

## Recommendations

1. Keep the file small and focused; avoid adding unrelated filesystem checks here.
2. If empty-string inputs should be invalid, validate them explicitly instead of relying on `||` fallback behavior.
3. Document the `repoSlug()` contract more clearly, especially that it is a sanitization helper, not a global uniqueness guarantee.
4. If cross-platform collisions become a real issue, add a deterministic normalization strategy or a stronger repo identifier before expanding behavior.

Overall: this is a clean, readable module with no serious hack smell. The biggest long-term concern is not current complexity, but whether the very simple slugging rules remain sufficient as repository/path scenarios grow.