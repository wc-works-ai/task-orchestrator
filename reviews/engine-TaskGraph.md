# Review: `src/engine/TaskGraph.ts`

I did not find any monkey-patches, post-hoc hacks, or "quick fix" code smells in this module. The implementation is small, focused, and reads like a deliberate utility rather than an accretion of special cases. `formatTaskGraph()` has one clear job: turn dependency data into a stable textual DAG view, while still surfacing two important data-quality problems: missing dependencies and cycles.

## Assessment

- **Consistency:** The file is internally consistent. It uses a single `GraphNode` shape, keeps formatting concerns local, and follows one traversal strategy throughout.
- **Readability:** For a compact function, readability is good. Variable names such as `byNum`, `indeg`, `dependents`, `level`, `emitted`, and `cyclic` are all understandable in context. The comment that this is a Kahn topological sort is especially helpful.
- **Extensibility:** The biggest limitation is that topology building, level computation, and string formatting are all in one function. That is still acceptable at this size, but if more render modes or annotations are added, splitting normalization / sort / render into helpers would make future changes safer.
- **Correctness:** The current behavior is sensible: present dependencies control ordering, missing dependencies are rendered explicitly, and cycles are reported separately. That said, the function relies on strong implicit invariants via non-null assertions (`!`) and assumes task numbers are unique. Duplicate `number` values would produce ambiguous results because the `Map` keeps only the last node while the outer loops still iterate the full input array.
- **Scalability:** For current CLI-style usage this is fine, but there are mild efficiency tradeoffs. `ready.shift()` is O(n), and `presentDeps()` re-filters dependency lists multiple times. None of that looks problematic for normal task counts, but it would be the first place to simplify if graph size grows substantially.
- **Design principles:** The design is sound and intentionally minimal. It avoids hidden global state, avoids monkey-patching, and keeps failure handling explicit in the rendered output rather than silently discarding bad graph structure.

## Concrete recommendations

1. **Document or enforce unique task numbers.** If uniqueness is guaranteed upstream, say so in the type contract or function comment. If not, reject duplicates early.
2. **Precompute normalized dependencies once** if the module grows. That would reduce repeated filtering and make missing/present dependency handling easier to reason about.
3. **Extract helpers only when needed.** Right now the single-function design is still proportionate; I would not refactor it preemptively.
4. **Consider a stronger `status` type** in the future if this output becomes more central, since `string` allows invalid values and weakens guarantees.

Overall: this is a clean utility module with no obvious hackiness. I would keep the implementation as-is unless future feature growth makes the implicit invariants or repeated dependency normalization harder to maintain.
