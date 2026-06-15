# Review of `src/shared/config.ts`

`src/shared/config.ts` does **not** contain a true monkey-patch: it does not mutate built-ins, rewrite imported modules, or hide behavior behind runtime patching. It is also cleaner than a typical “quick-fix” config file because most user-facing help text is declared through `CONFIG_SPEC`, `COMMAND_SPEC`, `OPERATION_SPEC`, and `EXAMPLES` rather than scattered through the CLI. That said, there are a few places that still look like **incremental convenience fixes** rather than one fully uniform design.

## Monkey-patches / quick-fix hacks

- `placeholder(flag)` is a hard-coded `if` ladder that knows about specific flag names (`repo`, `state-root`, `model`, `parallel`, etc.). It works, but it is a patch-like escape hatch beside the otherwise declarative `CONFIG_SPEC`. New flags require updating both the spec and this helper, which creates drift risk.
- `hasFlagValue(value)` encodes parser assumptions indirectly: only `true` or a non-empty string count as present. That is fine if the CLI parser always emits exactly those shapes, but it is still a small hidden contract rather than an explicit typed model.
- Default values such as `'current directory'`, `'agent default'`, `'unset'`, `'on'`, and `'off'` are presentation strings stored in the same spec that describes setting metadata. That is convenient for help output, but it mixes UI wording with configuration semantics.

## Structural assessment

### Consistency
This file is largely consistent. The declarative specs are the strongest part of the design, and the help/config formatters consume them in a predictable way. The main inconsistency is that most metadata lives in the spec, while placeholder rendering and “is this flag set?” logic live in separate hard-coded helpers.

### Readability
Readability is good. The file is short, data-first, and easy to scan. Group labels and field names are clear. The main readability cost is that a reader must jump between `CONFIG_SPEC`, `flagText()`, `placeholder()`, and `hasFlagValue()` to understand the full rendering rule for one option.

### Extensibility
The declarative approach scales better than hand-written help strings. Adding a new setting is mostly easy. However, extensibility weakens where behavior is keyed by flag name in `placeholder()`. That helper is a signal that some metadata that belongs in the spec is still encoded procedurally.

### Correctness
There is no obvious correctness bug in the current output logic, but there are a few fragile edges:
- `formatEffectiveConfig()` shows raw env-var text rather than normalized values, so booleans may display as `false`/`0`/`off` depending on input instead of one canonical form.
- `hasFlagValue()` depends on the parser never supplying numeric flag values as numbers. If that assumption changes, presence detection could become inconsistent.
- The spec stores defaults as display strings, so the file cannot distinguish “real default value” from “documentation text about the default.”

### Scalability
For the current config surface, this is fine. As more settings are added, the spec-driven structure will hold up reasonably well, but the separate hard-coded helpers will become maintenance hotspots because they require synchronized edits outside the spec.

### Design principles
The file mostly follows sound design principles: single responsibility is strong, duplication is limited, and the declarative tables are a good root-cause design choice instead of a stringly mess. The biggest design weakness is partial separation of concerns: configuration metadata, help formatting rules, and display-only placeholder/default text are not fully separated.

## Recommendations

1. Move placeholder metadata into `CONFIG_SPEC` itself (for example, an optional `placeholder` field) so new flags are fully declarative.
2. Replace `hasFlagValue()`’s loose `unknown` contract with a narrower typed representation from the CLI parser, or at least document the expected shapes more explicitly.
3. Consider separating “default display text” from “actual default semantic value” if this config system grows beyond help rendering.
4. Normalize displayed effective values for booleans and perhaps numbers so `--config` output is more consistent across flag and env sources.

Overall, `src/shared/config.ts` is **structured better than most quick-fix config modules** and contains no real monkey-patching, but it still has a few procedural helpers that undermine the otherwise clean declarative design. The best next step is not a rewrite, but finishing the move from helper-specific knowledge to spec-driven metadata.