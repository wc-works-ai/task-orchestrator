# Add Task

Use when: creating a new task for the orchestrator.

## Create the scaffold

```bash
orchestrator add <kebab-case-name>
```

Outputs the new directory in `tasks/pending/`. Task starts at `g = 1` (needs work).

## Fill in the details

Edit these files in the new task directory:

**`autoresearch.md`**
```markdown
- **Model:** <model-name>              # optional
## Goal
One-line description of what this task does.
## Design
Key decisions, required changes, what the fix should look like.
## Acceptance
Specific, verifiable criteria.
```

**`benchmark.js`**
```js
let g = 0;  // count gaps — reduce to 0
// Add checks. Example:
if (!readFile('path/file.md').includes('EXPECTED')) g++;
console.log('METRIC metric_name=' + g);
```
