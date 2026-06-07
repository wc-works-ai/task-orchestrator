# Add Orchestrator Task

Use when: creating a new task for the orchestrator to execute.

## Create the task

```bash
orchestrator add <kebab-case-name>
```

This scaffolds a task in `tasks/pending/` with the next available number. Output tells you the directory.

## Fill in the details

After scaffolding, edit these files in the new task directory:

**`autoresearch.md`** — replace TODOs with real content:
```markdown
- **Model:** <model-name>                    # optional — default is ORCH_MODEL
## Goal
One-line description of what this task accomplishes.
## Design
Key decisions, required sections, how the fix should look.
## Acceptance
Specific, verifiable criteria.
```

**`benchmark.js`** — replace `g = 1` with real checks:
```js
let g = 0; // no gaps found yet
// Add checks — each failure increments g
// Example:
if (!readFile('path/to/file').includes('EXPECTED')) g++;
console.log('METRIC my_gaps=' + g);
```

## After editing

```bash
orchestrator --status   # verify task shows as PENDING
orchestrator            # run one tick
orchestrator --loop     # run until done
```
