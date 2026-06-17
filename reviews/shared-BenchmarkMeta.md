# Review: `src/shared/BenchmarkMeta.ts`

`BenchmarkMeta.ts` is small, readable, and mostly disciplined. I do **not** see monkey-patching in the file, and there are no obvious "quick fix" hacks like stateful globals or ad-hoc mutation. The strongest part is `shouldRegenerate()`: its decision logic is short, pure, and easy to test, which gives the module a clear core responsibility.

That said, there are two important smell points. First, `readMeta()` uses a blanket `catch { return null; }`. Functionally this is safe because callers treat failure as "regenerate", but it silently collapses very different problems—missing file, invalid JSON, permission issues, truncated writes, or schema mismatch—into the same result. That is a correctness and operability tradeoff, and it also conflicts with the repo guidance to avoid silent error swallowing unless the operation is truly inconsequential. Second, the type and comments promise more than the behavior currently enforces: `hash` is documented as an anti-tamper guard and `genAttempts` as a crash-loop bound, but neither field participates in validation or regeneration decisions here. That makes the design look partially implemented and weakens consistency between documentation, data shape, and runtime behavior.

Assessment by dimension:
- **Consistency:** naming and comments are consistent, but the documented meaning of `hash`/`genAttempts` is inconsistent with actual usage.
- **Readability:** very good; the file is compact and the predicate is easy to follow.
- **Extensibility:** acceptable for a tiny module, but weak schema validation will make future metadata evolution brittle.
- **Correctness:** main risk is unchecked `JSON.parse(... ) as BenchmarkMeta`; malformed object shapes can pass through as trusted metadata.
- **Scalability:** fine for a tiny sidecar file; no performance concerns here.
- **Design principles:** mostly sound due to pure functions and narrow scope, but invariants are underspecified and error handling is too lossy.

Concrete recommendations:
1. Replace the unchecked cast with structural validation of parsed JSON before treating it as `BenchmarkMeta`.
2. Differentiate "file missing" from "file corrupt/unreadable" at least via logging, even if both still fall back to regeneration.
3. Either wire `hash` and `genAttempts` into real invariants/decisions, or remove/redefine them so the metadata contract matches reality.
4. If schema evolution is expected, add an explicit version field or validation helper now rather than relying on comment-only conventions.
