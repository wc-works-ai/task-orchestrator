# Review of `src/cli.ts`

I do **not** see any true monkey-patching in `src/cli.ts`: it does not rewrite built-ins, mutate imported modules, or rely on runtime patch layers to change behavior elsewhere. That is good. The more relevant concern is **quick-fix accumulation** inside one large entrypoint. The file currently mixes argument parsing, path resolution, task file editing, benchmark launching, agent creation, interactive merge recovery, engine wiring, and process-level exit handling. That is still understandable today, but it is trending toward a “god CLI module”.

## Assessment

- **Consistency:** The `handleXCommand` pattern is consistent, and the helper naming is mostly clear. The file generally matches project style.
- **Readability:** Small focused helpers help, but readability drops because control flow is fragmented by many `process.exit()` calls and repeated `try/catch + print + exit` branches.
- **Extensibility:** Adding another command or flag will likely grow this file further. Command-specific behavior should eventually move behind per-command modules.
- **Correctness:** The benchmark and prerequisite seams are solid, but the type assertions in CLI normalization (`as ParsedCliOptionValues`, `as CliOptionValues`) are a mild escape hatch that weakens static guarantees.
- **Scalability:** Centralized dispatch works for a small CLI, but this shape will become a merge hotspot as commands/options expand.
- **Design principles:** The biggest design issue is responsibility concentration, not hacks. `createEngine()` is a good composition boundary; the top-level command handlers are the main place where separation is starting to erode.

## Concrete recommendations

1. Extract command handlers (`status`, `graph`, `add`, `edit`, `unblock`, `task`, `check`) into dedicated modules that return outcomes instead of calling `process.exit()` internally.
2. Centralize user-facing error/report formatting so failure behavior is consistent and easier to test.
3. Replace the current type assertions around parsed values with a narrower typed adapter if possible.
4. Validate whether `--keep-converged` should reject negative numbers explicitly; today it accepts any finite integer.

Overall: no monkey-patch smell, but there **is** a structural quick-fix smell from too many concerns living in one file.