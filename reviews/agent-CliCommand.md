# Review of `src/agent/CliCommand.ts`

I do **not** see literal monkey-patching in `src/agent/CliCommand.ts`: it does not mutate globals, override imported modules, or install runtime patches. The main “quick-fix hack” smell is narrower and more specific: the Windows path resolves an npm-generated `.cmd` shim by shelling out to `where.exe`, reading the shim text, and extracting the Node entrypoint with a regex. That is understandable as a pragmatic compatibility fix, but it is still a shim-parser workaround tied to one command-wrapper format rather than a broad, explicit command-resolution abstraction.

## Assessment

- **Consistency:** The file is internally consistent. `resolveCliCommand()` is the public entrypoint and the two Windows helpers are private and focused.
- **Readability:** The code is short and easy to scan. The main readability cost is that the regex and npm-shim assumptions are implicit domain knowledge; a reader must already know why `pi.cmd`/`copilot.cmd` need to be bypassed.
- **Extensibility:** Extensibility is only moderate. The current logic is specialized for npm-style Windows cmd shims. If another package manager, wrapper format, or PowerShell shim becomes relevant, this code will likely grow by more special cases.
- **Correctness:** The fallback behavior is sensible: if lookup or parsing fails, it safely returns the original binary command. That said, correctness depends on a fragile text pattern match against the shim contents. Small upstream shim-format changes could silently disable the optimization.
- **Scalability:** The module scales fine at its current size, but the current approach does not scale well to many platform-specific resolution rules. Repeated special-case parsing would turn this utility into a compatibility bucket.
- **Design principles:** Separation of concerns is mostly good, but the Windows branch mixes command resolution with npm shim parsing details. That is acceptable now, though it is the clearest place where implementation detail leaks into the policy.

## Concrete recommendations

1. Keep the public contract exactly this small: `resolveCliCommand(bin, args)` is a good API surface.
2. Add a short comment explaining **why** Windows must bypass the `.cmd` shim and invoke `process.execPath` directly; that context currently lives only in the implementation.
3. Isolate shim parsing into a named parser helper or small documented strategy so the regex is easier to justify and test as behavior rather than as incidental text matching.
4. If more wrapper formats appear, prefer an explicit resolver strategy per format/platform instead of stacking more ad hoc regex branches into this file.
5. Consider whether unreadable shim files or `spawnSync` errors should be treated explicitly for observability, even if the runtime behavior still falls back to the original binary.

Overall, `src/agent/CliCommand.ts` is compact, readable, and functionally cautious. Its main weakness is not complexity but the presence of a narrow Windows shim workaround whose assumptions are currently under-documented and somewhat brittle. That is manageable today, but it is the area most likely to accumulate future quick-fix behavior if new command-wrapper cases are added.