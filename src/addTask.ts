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
      const m = e.match(/^T(\d+)-/); if (m?.[1]) next = Math.max(next, parseInt(m[1] ?? '0', 10));
    }} catch {}
  }
  next++;

  const goal = opts.goal ?? `TODO: describe what T${next} should accomplish`;
  const metric = opts.metric ?? 'TODO_metric_name';
  const scope = opts.scope?.length ? opts.scope : ['TODO: add scope files'];

  const d = resolve(tasksDir, 'pending', `T${String(next).padStart(2, '0')}-${name}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, '.status'), 'PENDING\n');
  writeFileSync(resolve(d, '.dependencies'), '');
  writeFileSync(resolve(d, 'autoresearch.md'), [
    `# T${next} — ${goal}`,
    '## Goal', goal,
    '## Metric', `\`${metric}\` (lower is better) — Target: 0`,
    '## Scope', ...scope.map(f => `- ${f}`),
    '## Acceptance', '- Every `METRIC <name>=<value>` criterion must be 0 for the convergence window',
  ].join('\n'));
  writeFileSync(resolve(d, 'benchmark.js'), [
    '#!/usr/bin/env node',
    '// Multiple METRIC lines are allowed; all must reach 0 before merge.',
    'let g = 1; // TODO: add real checks — reduce g to 0 when done',
    `console.log('METRIC ${metric}=' + g);`,
  ].join('\n'));

  return { number: next, name, directory: d, goal, metric, scope };
}
