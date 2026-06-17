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

## 2. Simplicity First

**Minimum code that solves the problem.**
- No features beyond what's asked.
- No abstractions for single-use code.
- No speculative "flexibility" or error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

## 3. Surgical Changes

**Touch only what you must.**
- Don't improve adjacent code or refactor unrelated things.
- Match existing style, even if you'd do it differently.
- Remove only YOUR unused imports/variables/functions.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**
- Test the fix works.
- Build passes.
- Coverage stays at 100%.
