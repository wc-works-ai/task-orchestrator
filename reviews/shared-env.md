# Review of `src/shared/env.ts`

`src/shared/env.ts` does **not** contain a true monkey-patch in the usual sense: it does not mutate built-ins, globals, or imported modules. That said, it does show a few **quick-fix / patch-like design smells** that are worth calling out. The module is trying to centralize environment parsing, which is good, but several rules are implemented ad hoc inside individual getters instead of through one consistent parsing layer.

## Monkey-patches / quick-fix hacks

- `autoStash` reimplements boolean parsing inline instead of using the existing `bool()` helper. That is a small duplication, but it is exactly the sort of local fix that spreads parsing rules across the file.
- Some numeric getters use shared helpers (`ms`, `parallel`, `maxFailures`), while others use raw `parseInt(...)` directly (`converge`, `heartbeatMs`, `progressTimeoutMs`, `agentLogMaxBytes`, `mergeLockMs`, `keepConverged`). This inconsistency looks like incremental patching over time rather than one deliberate design.
- `parallel()` both validates and emits `console.warn(...)`. That couples parsing to user-facing side effects, which is convenient in the short term but makes reuse and testing harder.

## Structural assessment

### Consistency
Mixed parsing styles are the biggest issue. Similar settings follow different validation rules, different defaults, and different failure behavior. For example, `parallel()` clamps and warns, `maxFailures()` falls back to `5`, `ms()` rejects negatives, while several direct `parseInt` getters can return `NaN` or negative values without correction.

### Readability
The file is short and easy to scan, which is a strength. Helper names are clear. However, readers must inspect each getter individually to discover validation behavior because the rules are not uniformly encoded.

### Extensibility
Adding a new env var is easy mechanically, but easy in a risky way: contributors can choose any parsing style they want. That increases drift. A spec-driven approach or a stricter set of shared parser helpers would scale better.

### Correctness
There is real correctness risk in the direct `parseInt` getters. Invalid values such as `ORCH_CONVERGE=abc` or negative timeout-like values can flow through as `NaN` or unsupported numbers. By contrast, the helper-based getters defend themselves better.

### Scalability
This pattern works while the config surface is small, but it will become harder to reason about as more variables are added. Centralized access alone is not enough; centralized validation rules matter too.

### Design principles
The module has a good single responsibility overall, but it partially violates DRY and separation of concerns. Parsing, defaulting, validation, and warning/reporting are not cleanly separated.

## Recommendations

1. Standardize all numeric parsing through shared helpers so every number has explicit invalid/negative handling.
2. Reuse `bool()` for `autoStash` to remove duplicated truthy parsing.
3. Consider moving warnings out of low-level parsers, or at least making them injectable/testable.
4. If this module continues to grow, define env metadata in one declarative spec so defaults and validation rules cannot drift.

Overall: the file is small and serviceable, but its main weakness is **inconsistent validation that suggests incremental quick fixes rather than one coherent configuration design**.