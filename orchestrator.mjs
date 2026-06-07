#!/usr/bin/env -S tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Engine } from './src/Engine.js';
import { TaskState } from './src/TaskState.js';
import { execSync } from 'node:child_process';

const TASKS = resolve(process.env.ORCH_TASKS ?? './tasks');

const { values } = parseArgs({
  options: {
    tasks:  { type: 'string', default: TASKS },
    loop:   { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    help:   { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`
Orchestrator — env: ORCH_TASKS (default: ./tasks)

  npm run stat         show dashboard
  npm run run          process one task
  npm run loop         run until all done
`);
  process.exit(0);
}

const dir = resolve(values.tasks!);

if (values.status) {
  const all = await TaskState.scan(dir);
  const c = { p: 0, ip: 0, cv: 0, f: 0, b: 0 };
  for (const [, t] of all) {
    if (t.isPending) c.p++;
    else if (t.isInProgress) c.ip++;
    else if (t.isConverged) c.cv++;
    else if (t.isFailed) c.f++;
    else if (t.isBlocked) c.b++;
  }
  console.log(`\n  ✅ ${c.cv}/${all.size} converged`);
  if (c.p)  console.log(`  ⬜ ${c.p} pending`);
  if (c.f)  console.log(`  ❌ ${c.f} failed`);
  if (c.ip) console.log(`  🔄 ${c.ip} active`);
  if (c.b)  console.log(`  🚫 ${c.b} blocked\n`);
  process.exit(0);
}

const engine = new Engine(dir, {
  benchmark: async (t) => {
    try {
      const out = execSync(`node ${t.directory}/benchmark.js`, {
        timeout: 30_000, encoding: 'utf-8', cwd: process.cwd(),
      });
      return parseInt(out.match(/METRIC\s+\w+=(\d+)/)?.[1] ?? '1', 10);
    } catch { return 1; }
  },
});

if (values.loop) {
  console.log(`Looping (${dir})`);
  const n = await engine.loop();
  console.log(`\n🎉 ${n} ticks\n`);
} else {
  const r = await engine.tick();
  if (r.task) {
    const icon = r.converged ? '✅' : r.metric === 0 ? '⏳' : '❌';
    console.log(`${icon} T${r.task.number}: metric=${r.metric}`);
  }
}
