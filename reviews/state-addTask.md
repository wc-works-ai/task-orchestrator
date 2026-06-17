# Review of `src/state/addTask.ts`

`addTask` is generally solid and does **not** look like a monkey-patch dump. The core flow is coherent: validate inputs, derive branch/retry settings, insert a `CREATING` row, write task files into a staging directory, rename into place, then promote to `PENDING`. That staging-then-publish sequence is the strongest part of the design because it keeps partially-written task content out of the visible task namespace.

## Monkey-patches / quick-fix hacks

I do not see an actual monkey-patch here, but I do see two small quick-fix style choices:

1. `detectBranch()` swallows every git error with `catch { return undefined; }`. That keeps task creation resilient, but it also hides the difference between "not a git repo" and "git failed unexpectedly". It is practical, yet it reduces observability.
2. The `autoresearch.md` and `benchmark.js` scaffolds are assembled inline as large string arrays. That is not wrong, but it is a shortcut that mixes policy text, template content, and creation orchestration in one function, which will drift as the task format evolves.

## Assessment

- **Consistency/readability:** Naming and comments are clear, and the linear flow is easy to follow. The file is short enough to reason about.
- **Extensibility:** Weaker here. `addTask` currently owns validation, git introspection, DB lifecycle, scaffold content generation, filesystem staging, cleanup, and return-shape assembly. If task templates or metadata keep growing, this function will become the bottleneck.
- **Correctness:** The staging rename is good defensive design. The main concern is that `tdb.promote(id)` returns a boolean, but the caller ignores it. If promotion ever fails or updates zero rows, `addTask` can report success while leaving a `CREATING` row behind.
- **Scalability:** Runtime cost is fine for task creation, but maintenance scalability is only moderate because template text is duplicated inline instead of centralized.
- **Design principles:** Mostly sound and root-cause oriented. The main SRP pressure comes from combining orchestration logic with template authoring.

## Recommendations

1. Treat `promote(id) === false` as an error so the function cannot silently succeed with an unpublished task.
2. Narrow `detectBranch` error handling: keep the graceful fallback, but at least log unexpected git failures.
3. Extract scaffold builders (for `autoresearch.md` and `benchmark.js`) into small helpers so policy text lives in one place and the orchestration path stays focused.

Overall: good structure, no obvious hacks, but a few silent-failure paths and inline-template shortcuts should be tightened before the file grows further.
