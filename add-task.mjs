#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const tasksDir = resolve(process.env.ORCH_TASKS ?? './tasks');
const pending = resolve(tasksDir, 'pending');

const name = process.argv[2];
const goal = process.argv[3];
const metric = process.argv[4];
const scope = process.argv.slice(5);

if (!name || !goal || !metric) {
  console.log('Usage: node add-task.mjs <name> "<goal>" <metric> [scope...]');
  console.log('Example: node add-task.mjs fee-model "Define fee model" fee_gaps docs/contracts/FEE_MODEL.md');
  process.exit(1);
}

// Find next task number
const { readdirSync } = await import('node:fs');
let next = 0;
try {
  for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    try {
      for (const e of readdirSync(resolve(tasksDir, s))) {
        const m = e.match(/^T(\d+)-/);
        if (m) next = Math.max(next, parseInt(m[1], 10));
      }
    } catch {}
  }
} catch {}
next++;

const dirName = `T${String(next).padStart(2, '0')}-${name}`;
const dir = resolve(pending, dirName);
mkdirSync(dir, { recursive: true });

// .status
writeFileSync(join(dir, '.status'), 'PENDING\n');
// .dependencies
writeFileSync(join(dir, '.dependencies'), '');
// autoresearch.md
writeFileSync(join(dir, 'autoresearch.md'), [
  `# T${next} — ${goal}`,
  '## Goal',
  goal,
  '## Metric',
  `\`${metric}\` (lower is better) — Target: 0`,
  '## Scope',
  ...scope.map(f => `- ${f}`),
  '## Acceptance',
  `- ${metric}=0 for 3 consecutive runs`,
].join('\n'));
// benchmark.js
writeFileSync(join(dir, 'benchmark.js'), [
  '#!/usr/bin/env node',
  'let g = 1; // TODO: add real checks',
  `console.log('METRIC ${metric}=' + g);`,
].join('\n'));

console.log(`✅ T${next} added: ${goal}`);
console.log(`   Directory: ${dir}`);
console.log(`   Next: edit ${dir}/benchmark.js with real checks`);
