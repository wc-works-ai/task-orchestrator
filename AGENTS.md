# AGENTS.md

> **⚠️ REQUIRED READING BEFORE ANY CODE CHANGE**
> 1. **`AGENTS.md`** — working rules for coding behavior
> 2. **`docs/INDEX.md`** — canonical documentation index (includes required docs)
>
> Run `npm run c && npm run t` before every commit.

Behavioral guidelines to reduce common LLM coding mistakes.

## 1. Think Before Coding

**Don't assume. Surface tradeoffs.**
- State assumptions explicitly. Ask if uncertain.
- Present multiple interpretations — don't pick silently.
- If something is unclear, stop and ask.
- **Consider ALL failure scenarios** before implementing — not just the happy path.

## 2. No Monkey-Patching

**Fix root causes. Never patch symptoms.**
- If a fix requires another fix, the first fix was wrong. Back out and rethink.
- Never add code that works around a bug elsewhere — fix the bug.
- Every catch must log, rethrow, or return a meaningful fallback. Never `catch {}`.
- If you don't fully understand why something fails, stop and investigate — don't guess.

## 3. Simplicity First

**Minimum code that solves the problem.**
- No features beyond what's asked.
- No abstractions for single-use code.
- No speculative "flexibility" or error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

## 4. Surgical Changes

**Touch only what you must.**
- Don't improve adjacent code or refactor unrelated things.
- Match existing style, even if you'd do it differently.
- Remove only YOUR unused imports/variables/functions.

## 5. Goal-Driven Execution

**Define success criteria. Loop until verified.**
- Test the fix works.
- Build passes.
- Coverage stays at 100%.
- **Run the actual program** — don't just trust unit tests.
