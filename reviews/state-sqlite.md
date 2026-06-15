# Review of `src/state/sqlite.ts`

`src/state/sqlite.ts` is a small, focused adapter and is in noticeably better shape than a typical “quick fix” SQLite wrapper. I do **not** see literal monkey-patching here: the file does not override runtime behavior, mutate upstream prototypes, or patch `node:sqlite` globally. The closest thing to a pragmatic workaround is the localized `DynStmt` cast in `#bind()`, which accepts the driver’s dynamic call shape in one place instead of leaking `unknown`/`any` across the codebase. That is a reasonable containment strategy, but it is still a sign that the adapter is compensating for an unstable or inconvenient API surface.

## Monkey-patches / quick-fix hacks

1. **Localized dynamic statement cast** — `this.#db.prepare(sql) as unknown as DynStmt` is not a monkey-patch, but it is a deliberate type escape hatch. The good news is that it is quarantined to one private method with a comment explaining why.
2. **String-literal WAL enforcement** — `requireWal()` rejects anything except `'wal'`. That is defensively correct for this app, but it is also a coarse guardrail that assumes the pragma response shape never changes.
3. **Manual transaction wrapper** — the explicit `BEGIN IMMEDIATE` / `ROLLBACK` / `COMMIT` sequence is simple and readable, but it is also a minimal homegrown transaction layer. It works for current usage, yet it leaves nested-transaction behavior and commit-failure semantics implicit.

## Assessment

- **Consistency:** Strong. Naming is clear, responsibilities are narrow, and the file keeps SQLite-specific behavior behind the `Db` interface.
- **Readability:** Good overall. The top-level comments help, and `openDb`, `requireWal`, and `SqliteDb` each have obvious roles. The only “magic” is the dynamic binding cast.
- **Extensibility:** Reasonable for current scale, but the wrapper is intentionally thin. If more SQLite-specific behavior accumulates here, statement preparation, transaction policy, and pragma policy may deserve explicit helpers rather than more inline conventions.
- **Correctness:** Solid for the tested cases. The main correctness risks are edge semantics, not obvious bugs: `Number(...)` conversion can theoretically truncate very large `bigint` rowids/change counts, and `transaction()` does not document whether nesting is unsupported or intentionally forbidden.
- **Scalability:** Runtime scalability is fine for a synchronous orchestration state DB. Maintenance scalability is also decent because the unstable-driver concerns are centralized.
- **Design principles:** This file mostly follows sound design principles: small surface area, single responsibility, and explicit driver isolation.

## Recommendations

1. Keep the dynamic cast localized exactly as it is, but consider a slightly more explicit internal helper name or comment that frames it as a driver-boundary adaptation rather than a general typing pattern.
2. Document transaction nesting expectations. If nested transactions are invalid by design, say so; if they may become useful, switch to `SAVEPOINT`-based nesting rather than layering more ad hoc fixes later.
3. If the application could ever create very large row counts/rowids, guard or document the `bigint` → `number` narrowing so the behavior is intentional rather than accidental.
4. Avoid expanding this module into a catch-all for SQLite policy. Its current strength is that it is a narrow adapter, not a dumping ground for higher-level state logic.

Overall, this file looks disciplined rather than hacky. I would keep the code unchanged unless a concrete bug or new requirement justifies tightening transaction semantics or numeric conversion behavior.
