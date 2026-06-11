#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { addTask } from './addTask.js';
import { Engine } from './Engine.js';
import { TaskState, type TaskInfo } from './TaskState.js';
import { PiSpawner } from './PiSpawner.js';
import { Prerequisites } from './Prerequisites.js';
import { env } from './env.js';
import { resolveStatePaths } from './StatePaths.js';

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const { values, positionals } = await parseArgs({
  allowPositionals: true,
  options: {
    repo:   { type: 'string', default: '' },
    'state-root': { type: 'string', default: '' },
    tasks:  { type: 'string', default: '' },
    loop:   { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    check:  { type: 'boolean', default: false },
    model:  { type: 'string', default: '' },
    stop:   { type: 'boolean', default: false },
    task:   { type: 'string', short: 't', default: '' },
    goal:   { type: 'string', default: '' },
    metric: { type: 'string', default: '' },
    scope:  { type: 'string', default: '' },
    once:   { type: 'boolean', default: false },
    worktrees: { type: 'string', default: '' },
    help:   { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`
Task Orchestrator — autonomous task execution

  orchestrator --state-root <dir> run until all tasks complete (loop)
  orchestrator --state-root <dir> --once
  orchestrator --state-root <dir> --status
  orchestrator --state-root <dir> --check
  orchestrator --state-root <dir> --stop
  orchestrator --state-root <dir> --task <n>
  orchestrator --repo <dir>     override target repo/folder (default: current directory)
  orchestrator --tasks <dir>    override derived task directory
  orchestrator --worktrees <dir> override derived worktree directory
  orchestrator --state-root <dir> add <name>
  orchestrator --state-root <dir> add <name> --goal "..." --metric x --scope "a b"

Resolution order for optional settings: CLI flag > environment variable > derived default.

Environment variables:
  ORCH_REPO=<dir>            optional target repo/folder override
  ORCH_STATE_ROOT=<dir>      required orchestrator state root
  ORCH_TASKS=<dir>           optional task directory override
  ORCH_WORKTREES=<dir>       optional worktree directory override
  ORCH_MODEL=<model>         model override (uses pi default when unset)
  ORCH_CONVERGE=<n>          zero-runs to converge (default: 3)
  ORCH_MAX_FAILURES=<n>      failures before BLOCKED (default: 5)
  ORCH_HEARTBEAT_MS=<ms>     stale claim timeout (default: 300000)
  ORCH_PROGRESS_TIMEOUT=<ms> kill agent after no output (default: 120000)
`);
  process.exit(0);
}

let paths;
try {
  paths = resolveStatePaths({
    repo: values.repo || env.repoDir || process.cwd(),
    stateRoot: values['state-root'] || env.stateRoot,
    tasks: values.tasks || env.tasksDir,
    worktrees: values.worktrees || env.worktreesDir,
  });
} catch (e: unknown) {
  console.error(`\n  ❌ ${e instanceof Error ? e.message : String(e)}`);
  console.error('  Example: orchestrator --state-root Q:\\Orchestrator\n');
  process.exit(1);
}

const repo = paths.repo;
const dir = paths.tasks;
const worktreesDir = paths.worktrees;

console.log(`repo: ${repo}`);
console.log(`tasks: ${dir}`);
console.log(`worktrees: ${worktreesDir}`);

if (!existsSync(repo)) {
  console.error(`\n  ❌ Repo folder not found: ${repo}\n`);
  process.exit(1);
}
mkdirSync(paths.stateRoot, { recursive: true });
mkdirSync(worktreesDir, { recursive: true });

// ── edit command ─────────────────────────────────────────────────────────
if (positionals[0] === 'edit') {
  const tn = parseInt(positionals[1] ?? '', 10);
  if (isNaN(tn)) { console.error('Usage: orchestrator edit <n> [--goal ...] [--metric ...] [--scope ...]'); process.exit(1); }
  const engine = new Engine(dir, { repoDir: repo });
  const task = await engine.pickByNumber(tn);
  if (!task) { console.error(`T${tn} not found`); process.exit(1); }
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ar = readFileSync(join(task.directory, 'autoresearch.md'), 'utf-8');
  let updated = ar;
  if (values.goal) updated = updated.replace(/^## Goal.*$/m, `## Goal: ${values.goal}`);
  if (values.metric) updated = updated.replace(/\`[^`]+\` \(lower is better\)/, `\`${values.metric}\` (lower is better)`);
  if (values.scope) {
    const lines = values.scope.split(/\s+/).map(f => `- ${f}`).join('\n');
    updated = updated.replace(/^## Scope\n[\s\S]*?(?=^## |\Z)/m, `## Scope\n${lines}\n`);
  }
  writeFileSync(join(task.directory, 'autoresearch.md'), updated);
  console.log(`✅ T${tn} updated`);
  process.exit(0);
}

// ── add command ──────────────────────────────────────────────────────────
if (positionals[0] === 'add') {
  const name = positionals[1];
  if (!name) { console.error('Usage: orchestrator add <name> [--goal ...] [--metric ...] [--scope ...]'); process.exit(1); }
  const opts: Record<string, string | string[]> = {};
  if (values.goal) opts.goal = values.goal;
  if (values.metric) opts.metric = values.metric;
  if (values.scope) opts.scope = values.scope.split(/\s+/);
  const r = addTask(dir, name, opts);
  console.log(`✅ T${r.number} added: ${name}`);
  console.log(`   ${r.directory}`);
  console.log(`   Next: edit autoresearch.md + benchmark.js, then npm run tick`);
  process.exit(0);
}

if (values.check) {
  const results = await Prerequisites.check();
  console.log(Prerequisites.format(results));
  process.exit(results.every(r => r.ok) ? 0 : 1);
}


if (values.status) {
  const all = await TaskState.scan(dir);
  const nums = [...all.keys()].map(Number).sort((a, b) => a - b);
  console.log('');
  for (const k of nums) {
    const t = all.get(String(k));
    if (!t) continue;
    let icon = '❓';
    if (t.isConverged) icon = '✅';
    else if (t.isFailed) icon = '❌';
    else if (t.isBlocked) icon = '🚫';
    else if (t.isPending) icon = '⬜';
    else if (t.isInProgress) icon = '🔄';
    const deps = t.dependencies.length > 0 ? `  ← depends: ${t.dependencies.join(', ')}` : '';
    const goal = t.goal.length > 55 ? t.goal.slice(0, 52) + '...' : t.goal;
    console.log(`  ${icon} T${k} ${goal}${deps}`);
    if (t.isBlocked) {
      console.log(`       blocked after ${t.failureCount} failures`);
    }
  }
  console.log(`  ─ ${all.size} total\n`);
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

const spawner = new PiSpawner({
  ...(values.model ? { model: values.model } : {}),
  workDir: repo,
});

if (values.stop) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(dir, '.stop'), '');
  console.log('Stop signal sent.');
  process.exit(0);
}

// Verify tasks directory exists before running
if (!existsSync(dir)) {
  console.error(`\n  ❌ Tasks directory not found: ${dir}`);
  console.error('  Create it with the add command, or pass --tasks / ORCH_TASKS to an existing task folder.\n');
  process.exit(1);
}

// Resolve the effective worktrees directory for robust benchmark cwd detection.
// Use a path-prefix check instead of fragile substring matching to avoid
// false positives when the repo path itself contains '.worktrees/'.
const effectiveWorktreesDir = worktreesDir;

const engine = new Engine(dir, {
  repoDir: repo,
  worktreesDir,
  spawn: (task, worktreePath, signal) => spawner.spawn(task, worktreePath, signal),
  benchmark: async (t: TaskInfo) => {
    try {
      const out = execSync(`node ${t.directory}/benchmark.js`, {
        timeout: 30_000, encoding: 'utf-8',
        cwd: isPathInside(t.directory, effectiveWorktreesDir) ? t.cwd : repo,
      });
      return parseInt(out.match(/METRIC\s+\w+=(\d+)/)?.[1] ?? '1', 10);
    } catch { return 1; }
  },
});

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

if (values.once) {
  const r = await engine.tick();
  if (r.task) {
    const icon = r.converged ? '✅' : r.metric === 0 ? '⏳' : '❌';
    console.log(`${icon} T${r.task.number}: metric=${r.metric}`);
  } else {
    console.log('Nothing actionable.');
  }
} else {
  console.log('Running until tasks complete');
  const n = await engine.loop({
    onTick: (r) => {
      if (r.task) {
        const icon = r.converged ? '✅' : r.metric === 0 ? '⏳' : '❌';
        const status = r.converged ? 'converged' : r.metric === 0 ? 'convergence pending' : `metric=${r.metric}`;
        console.log(`  ${icon} T${r.task.number}: ${status} — ${r.task.goal.slice(0, 60)}`);
      }
    },
  });
  console.log(`\n🎉 ${n} ticks — all done\n`);
}
