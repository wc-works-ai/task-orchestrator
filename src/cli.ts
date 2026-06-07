#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Engine } from './Engine.js';
import { TaskState, type TaskInfo } from './TaskState.js';
import { PiSpawner } from './PiSpawner.js';
import { Prerequisites } from './Prerequisites.js';

const tasksDir = resolve(process.env.ORCH_TASKS ?? './tasks');
const repoDir = resolve(process.env.ORCH_REPO ?? findRepoRoot(tasksDir));

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (dir !== '/') {
    if (existsSync(resolve(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const { values } = await parseArgs({
  options: {
    tasks:  { type: 'string', default: tasksDir },
    loop:   { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    check:  { type: 'boolean', default: false },
    model:  { type: 'string', default: '' },
    stop:   { type: 'boolean', default: false },
    task:   { type: 'string', short: 't', default: '' },
    help:   { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`
Task Orchestrator — autonomous task execution

  orchestrator                  process one task
  orchestrator --loop           run until all done
  orchestrator --status         show dashboard
  orchestrator --check          check prerequisites
  orchestrator --stop           signal all instances to stop
  orchestrator --tasks <dir>    custom task directory
  orchestrator --model <model>  default AI model

Environment variables (CLI flags override):
  ORCH_TASKS=<dir>         task directory (--tasks)
  ORCH_REPO=<dir>          git repo root for worktrees
  ORCH_MODEL=<model>       default AI model (--model)
  ORCH_CONVERGE=<n>        zero-runs to converge (default: 3)
  ORCH_MAX_FAILURES=<n>    failures before BLOCKED (default: 5)
  ORCH_HEARTBEAT_MS=<ms>   stale claim timeout (default: 300000)
`);
  process.exit(0);
}

if (values.check) {
  const results = await Prerequisites.check();
  console.log(Prerequisites.format(results));
  process.exit(results.every(r => r.ok) ? 0 : 1);
}

const dir = resolve(values.tasks!);
const repo = resolve(repoDir);

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

// Quick prerequisite check before running
const prereqs = await Prerequisites.check();
const failed = prereqs.filter(r => !r.ok);
if (failed.length > 0) {
  console.error(Prerequisites.format(prereqs));
  if (failed.some(r => r.name === 'node')) process.exit(1);
  // pi/API key missing — warn but continue (user might have custom benchmark)
}

const spawner = new PiSpawner(values.model ? { model: values.model } : {});

if (values.stop) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(dir, '.stop'), '');
  console.log('Stop signal sent.');
  process.exit(0);
}

// Verify tasks directory exists before running
if (!existsSync(dir)) {
  console.error(`\n  ❌ Tasks directory not found: ${dir}`);
  console.error(`  Create it or set ORCH_TASKS to a valid path.\n`);
  process.exit(1);
}

const engine = new Engine(dir, {
  repoDir: repo,
  spawn: (task) => spawner.spawn(task),
  benchmark: async (t: TaskInfo) => {
    try {
      const out = execSync(`node ${t.directory}/benchmark.js`, {
        timeout: 30_000, encoding: 'utf-8', cwd: repo,
      });
      return parseInt(out.match(/METRIC\s+\w+=(\d+)/)?.[1] ?? '1', 10);
    } catch { return 1; }
  },
});

// Verify tasks directory exists before running
if (!existsSync(dir)) {
  console.error(`\n  ❌ Tasks directory not found: ${dir}`);
  console.error(`  Create it or set ORCH_TASKS to a valid path.\n`);
  process.exit(1);
}

// Force-pick a specific task by number
if (values.task) {
  const tn = parseInt(values.task, 10);
  if (isNaN(tn)) { console.error('Invalid task number'); process.exit(1); }
  const task = await engine.pickByNumber(tn);
  if (!task) { console.error(`T${tn} not found`); process.exit(1); }
  try {
    const out = execSync(`node ${task.directory}/benchmark.js`, { timeout: 30_000, encoding: 'utf-8', cwd: repo });
    const metric = parseInt(out.match(/METRIC\s+\w+=(\d+)/)?.[1] ?? '1', 10);
    console.log(`${metric === 0 ? '⏳' : '❌'} T${tn}: ${task.goal.slice(0, 60)} (metric=${metric})`);
  } catch { console.log(`❌ T${tn}: benchmark failed`); }
  process.exit(0);
}

if (values.loop) {
  console.log(`Looping (${dir}, repo: ${repo})`);
  const n = await engine.loop({
    onTick: (r) => {
      if (r.task) console.log(`  ${r.converged ? '✅' : '⏳'} T${r.task.number}: ${r.task.goal.slice(0, 60)}`);
    },
  });
  console.log(`\n🎉 ${n} ticks\n`);
} else {
  const r = await engine.tick();
  if (r.task) {
    const icon = r.converged ? '✅' : r.metric === 0 ? '⏳' : '❌';
    console.log(`${icon} T${r.task.number}: metric=${r.metric}`);
  }
}
