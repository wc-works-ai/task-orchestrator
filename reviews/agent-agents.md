# Review of `src/agent/agents.ts`

I do **not** see any monkey-patching in `src/agent/agents.ts`. The module does not rewrite globals, mutate imported implementations, or install runtime overrides. I also do not see obvious emergency-style quick-fix hacks. The file is intentionally small and acts as a narrow factory/registry boundary for coding-agent selection.

## Assessment

- **Consistency:** The file is consistent with the surrounding agent design. Each supported agent is imported explicitly, registered under a short string key, and constructed through the same `(opts) => new Agent(opts)` shape.
- **Readability:** Readability is strong because the file is tiny and the control flow is linear. `REGISTRY`, `SUPPORTED_AGENTS`, and `createCodingAgent()` communicate their purposes immediately.
- **Extensibility:** Extensibility is decent for the current scale: adding a new agent is straightforward and visible. The tradeoff is that registration is manual, so new agents must be added in multiple places by convention rather than through a more strongly typed registration API.
- **Correctness:** Defaulting `undefined` and `''` to `pi` is simple and predictable. Unsupported names fail fast with a useful error that includes supported values. One correctness/design wrinkle is that agent names remain stringly typed, so mismatches are only caught at runtime.
- **Scalability:** The current approach scales well to a small number of agents. If the list grows significantly, this file could become a merge hotspot and the plain `Record<string, ...>` shape would offer less compile-time protection than a narrower derived type.
- **Design principles:** Separation of concerns is good: selection logic stays here instead of leaking into callers. Dependency inversion is preserved because callers receive the `CodingAgent` interface, not concrete types. The main weakness is type precision rather than architecture.

## Concrete recommendations

1. Keep this file small and registry-focused; that is already its biggest strength.
2. Consider deriving an `AgentName` type from the registry keys so internal call sites can get compile-time checking instead of relying purely on runtime strings.
3. Consider exporting a readonly supported-agent list to avoid accidental mutation of `SUPPORTED_AGENTS` by consumers.
4. If agent registration grows, move toward a slightly more declarative registry helper, but only when the current manual map becomes painful.

Overall, `src/agent/agents.ts` is clean, readable, and free of monkey-patch behavior. Its main improvement area is stronger type-safety around supported agent names, not structural cleanup or behavioral fixes.
