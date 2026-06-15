# Review of `src/agent/CodingAgent.ts`

I do **not** see any monkey-patching in `src/agent/CodingAgent.ts`. The file does not mutate globals, rewrite imported modules, or install runtime behavior overrides. I also do not see obvious “quick-fix hack” code in the usual sense. The bigger structural smell is subtler: this file mixes the core agent contract with a handful of generic helper functions, which is fine at its current size but could gradually turn the interface file into a miscellaneous shared-utility bucket.

## Assessment

- **Consistency:** The naming is clear and consistent. `TokenUsage`, `SpawnResult`, `PrerequisiteResult`, `CodingAgentOptions`, and `CodingAgent` form a coherent contract surface for agent adapters.
- **Readability:** The file is short, direct, and easy to scan. Small pure helpers such as `positiveInt`, `countOccurrences`, `tail`, `resolveModel`, and `resolveReasoning` are readable and side-effect free.
- **Extensibility:** The interface-based design is strong. New agents can implement `CodingAgent` without depending on concrete agent classes, and `SpawnFn` gives tests/integration points a simple seam.
- **Correctness:** The helper functions are straightforward, but `SpawnResult` is a weak spot: its optional fields allow logically inconsistent states such as `success: true` with `error`, or `authFailure: true` without a clear failure shape. The code likely relies on convention rather than type-enforced invariants.
- **Scalability:** Today the file scales well because it is small. The risk is future accretion: every cross-agent helper may get dropped here because it is already “shared,” making the contract module harder to reason about.
- **Design principles:** Dependency inversion is good: the rest of the system can target the `CodingAgent` abstraction. Interface segregation is also decent because the contract stays narrow. The main design gap is data modeling: `SpawnResult` would be safer as a discriminated union with explicit success/failure variants.

## Concrete recommendations

1. Keep this file focused on **shared contracts** first. If more helpers appear, move them into a dedicated `src/agent` utility module instead of growing this interface file into a grab bag.
2. Strengthen `SpawnResult` into a discriminated union so invalid result combinations become unrepresentable at compile time.
3. Consider whether `resolveModel` and `resolveReasoning` should treat an empty string as “unset” forever. If that is intentional, document it; if not, tighten the types or logic.
4. Keep the current small-function style. It is cleaner than embedding these checks ad hoc across individual agent implementations.

Overall, `src/agent/CodingAgent.ts` is structurally clean, free of monkey-patch behavior, and easy to extend. Its main improvement area is not readability but stronger type-level guarantees around spawn outcomes and preventing this contract file from becoming a future catch-all utility module.
