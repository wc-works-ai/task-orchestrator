# Review of `src/state/TaskState.ts`

`TaskState` is mostly disciplined code, not a monkey-patch graveyard, but it does contain a few compatibility/workaround patterns that are worth calling out.

## Monkey-patches / quick-fix hacks

1. **`CREATING` is surfaced as `PENDING`** in `status()`. That is a deliberate compatibility shim: it hides a real DB state from callers so older "not yet started" logic keeps working. It may be practical, but it also means the public view is not a faithful projection of persisted state.
2. **`info` materializes a plain object instead of returning `this`** because spread callers would otherwise lose getter-backed fields. That comment is honest, but it is still an API-shape workaround rather than a clean model boundary.
3. **`#readAutoresearch()` silently swallows every read failure and returns `''`.** This is the sharpest quick fix in the file. It keeps the system moving, but it also hides malformed paths, permission issues, and unexpected I/O failures.

## Assessment

- **Consistency:** Sectioning, naming, and comments are strong. Claim-gated mutations consistently delegate to `TaskDb`, which keeps lease rules centralized.
- **Readability:** The file is easy to scan, but it mixes several concerns: DB-backed live state, markdown parsing, dependency inspection, and repository-pruning/static orchestration helpers.
- **Extensibility:** The regex-based metadata parsing works for today's narrow markdown shape, but more task metadata or richer syntax will make this class grow awkwardly.
- **Correctness:** The silent catch is the main correctness/diagnostic risk. Returning `PENDING` when a row disappears also favors resilience over observability.
- **Scalability:** Every content getter rereads and reparses `autoresearch.md`; `info` triggers several such reads in one call. Fine for tiny workloads, but not ideal as task counts or polling frequency rise.
- **Design principles:** The class is sounder than many "state" objects because writes stay in `TaskDb`, yet SRP is stretched by combining live state view, markdown parsing, and static maintenance utilities.

## Recommendations

1. Replace the silent `catch {}` in `#readAutoresearch()` with narrower error handling plus at least minimal logging.
2. Extract markdown parsing into a small helper/value object so `TaskState` remains focused on state projection and mutations.
3. Consider memoizing parsed autoresearch content per instance, or exposing one parsed-content snapshot, to avoid repeated file reads.
4. If `CREATING -> PENDING` must remain, document it as an explicit compatibility contract and keep the translation localized.

Overall: the file is structurally decent and not obviously hacky, but the hidden-state translation and silent file-read fallback are real quick-fix patterns that should be tightened before more responsibility is added.
