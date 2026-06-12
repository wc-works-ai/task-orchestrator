import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AddTaskOptions {
  readonly goal?: string;
  readonly metric?: string;
  readonly scope?: readonly string[];
}

export function addTask(tasksDir: string, name: string, opts: AddTaskOptions = {}) {
  if (!name || /[/\\<>:"|?*]/.test(name) || name.includes('..') || /^\s|\s$/.test(name)) {
    throw new Error(`Invalid task name "${name}": must not contain path separators, shell metacharacters, or leading/trailing whitespace`);
  }
  if (opts.metric && !/^\w+$/.test(opts.metric)) {
    throw new Error(`Invalid metric name "${opts.metric}": must match /^\\w+$/ (letters, digits, underscore)`);
  }
  let next = 0;
  for (const s of ['pending','in_progress','converged','failed','blocked']) {
    try { for (const e of readdirSync(resolve(tasksDir, s))) {
      const m = e.match(/^T(\d+)-/); if (m?.[1]) next = Math.max(next, parseInt(m[1]!, 10));
    }} catch {}
  }
  next++;

  const goal = opts.goal ?? `TODO: describe what T${next} should accomplish`;
  const metric = opts.metric ?? 'goal';
  const scope = opts.scope?.length ? opts.scope : ['TODO: add scope files'];

  const d = resolve(tasksDir, 'pending', `T${String(next).padStart(2, '0')}-${name}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, '.status'), 'PENDING\n');
  writeFileSync(resolve(d, '.dependencies'), '');
  writeFileSync(resolve(d, 'autoresearch.md'), [
    `# T${next} — ${goal}`,
    '## Goal', goal,
    '## Metrics',
    `- \`${metric}\` — task-specific deliverable; replace the placeholder check in \`benchmark.js\``,
    '- `build` — `npm run c` must pass',
    '- `test` — `npm run t` must pass',
    '## Scope', ...scope.map(f => `- ${f}`),
    '## Acceptance',
    '- Task benchmark: `benchmark.js` runs task-specific checks and emits `METRIC name=value` lines.',
    '- Global verify: `ORCH_VERIFY_CMD` runs repo-wide gates before merge (for example `npm run tc` for coverage).',
    '- ALL emitted metrics must be 0 for convergence.',
    '- Convergence requires 3 consecutive zero runs.',
  ].join('\n'));
  writeFileSync(resolve(d, 'benchmark.js'), [
    '#!/usr/bin/env node',
    "import { execSync } from 'node:child_process';",
    '',
    '// Task benchmark scaffold: emit one METRIC line per acceptance criterion.',
    '// ALL metrics must be 0 before the task can converge.',
    'const report = (name, value) => console.log(`METRIC ${name}=${value}`);',
    '',
    'const check = (name, command) => {',
    '  try {',
    "    execSync(command, { stdio: 'ignore' });",
    '    report(name, 0);',
    '  } catch {',
    '    report(name, 1);',
    '  }',
    '};',
    '',
    `// TODO: replace this placeholder with a real command that exits 0 only when the ${metric} deliverable is done.`,
    `check('${metric}', 'node -e "process.exit(1)"');`,
    '',
    '// Keep task-specific checks here. Put repo-wide gates like coverage in ORCH_VERIFY_CMD',
    '// so they run globally before merge (for example: npm run tc).',
    "check('build', 'npm run c');",
    "check('test', 'npm run t');",
  ].join('\n'));

  return { number: next, name, directory: d, goal, metric, scope };
}
