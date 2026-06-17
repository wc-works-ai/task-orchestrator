# Review of `src/shared/metrics.ts`

## Quick-fix / monkey-patch assessment
I do not see any monkey-patching in this module. It is a small, pure utility file with no mutation of globals, prototypes, process state, or imported modules. It also does not look like it contains an obvious emergency workaround such as duplicated branches, special-case flags, or hidden side effects added to mask another defect. The closest thing to a "quick-fix" smell is the intentionally preserved decimal handling: the regex plus `parseInt` means `METRIC x=42.5` becomes `42`, and the tests explicitly lock that behavior in. That is controlled and documented by tests, but it is still surprising enough to deserve attention because it silently normalizes malformed or broader-than-expected input instead of rejecting it.

## Structure and consistency
The file is structurally strong overall. Each export has a single concern:
- `parseMetrics` extracts and totals metric lines.
- `unmetSummary` formats non-zero criteria.
- `classifyBenchmark` adds benchmark-state semantics (`ok`, `crash`, `no_metrics`).

The naming is consistent, types are small and clear, and the immutable return shapes make the module predictable. Comments are focused and explain the non-obvious `only` behavior well.

## Readability
Readability is generally good because the logic is short and linear. The only part that takes a second pass is the `only.flatMap(... all.filter(...))` path in `parseMetrics`: it mixes filtering policy, duplicate-resolution policy, and aggregation in one expression. It is still understandable, but the behavior is important enough that a slightly more explicit implementation could be easier to maintain.

## Extensibility
This module is easy to extend at the API level, but the parsing grammar is narrow:
- metric names are limited to `\w+`
- values are effectively non-negative integers
- decimal-looking values are truncated rather than rejected
- negative values are not representable

If future benchmarks ever emit decimals, signed deltas, or hyphenated metric names, this parser will need a deliberate update. The main recommendation is to make the input contract explicit: either support only integers and reject anything else clearly, or broaden parsing intentionally and update the types/tests accordingly.

## Correctness
The benchmark classification logic is sound: crashes win over printed metrics, and an empty filtered result is treated as `no_metrics` instead of normal work remaining. That separation is a good root-cause fix compared with older designs that collapsed every failure mode into a single fallback number.

The main correctness risk is silent coercion. `METRIC x=42.5` currently becomes `42`, which may hide benchmark bugs and undercount work. If integer-only metrics are the rule, explicit rejection would be safer than partial parsing.

## Scalability
For current benchmark output sizes this is fine. The only scaling concern is the repeated `all.filter(...)` for every requested metric name, which is O(metricNames × emittedMetrics). That is acceptable today, but a single-pass map or reverse scan would be cleaner if outputs or metric lists grow.

## Design principles
The module follows good design principles overall: pure functions, no hidden state, clear data contracts, and strong testability. My only design recommendation is to keep tightening the boundary between "missing/invalid measurement" and "real numeric measurement." `classifyBenchmark` already moves in that direction; making unsupported metric formats explicit would complete that story.

## Recommended actions
1. Decide whether decimal values are invalid or supported; avoid the current silent truncation long term.
2. If the parser evolves, consider a single-pass implementation for the `only` case.
3. Keep the current separation between parsing and benchmark-state classification; that is the strongest part of the design.
