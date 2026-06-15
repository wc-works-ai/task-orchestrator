#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { addTask } from './state/addTask.js';
import { Engine, MergeRecoveryAction, type MergeRecoveryFailure } from './engine/Engine.js';
import { TaskState, type TaskInfo } from './state/TaskState.js';
import { TaskDb } from './state/TaskDb.js';
import { createCodingAgent } from './agent/agents.js';
import type { CodingAgent } from './agent/CodingAgent.js';
import { Prerequisites } from './agent/Prerequisites.js';
import { env } from './shared/env.js';
import { resolveStatePaths } from './state/StatePaths.js';
import { printOverview, printRunSummary } from './engine/RunReport.js';
import { parseMetrics, unmetSummary, classifyBenchmark } from './shared/metrics.js';
import { formatTaskGraph, type GraphNode } from './engine/TaskGraph.js';
import { formatEffectiveConfig, formatHelp } from './shared/config.js';
import { appVersion } from './shared/version.js';

async function promptMergeRecovery(failure: MergeRecoveryFailure): Promise<MergeRecoveryAction> {
  console.error('');
  console.error(`  ⚠️  T${failure.task.number} could not merge ${failure.branch}`);
  console.error(`  worktree: ${failure.worktreePath}`);
  console.error(`  reason: ${failure.error}`);
  console.error('  NOTE: "Your local changes" refers to uncommitted edits in the WORKTREE (the agent\'s work), not the main repo.');
  if (!input.isTTY) {
    console.error('  Non-interactive shell: blocking the task and keeping the worktree for inspection.');
    return MergeRecoveryAction.Stop;
  }

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question(
        '  How should orchestrator proceed? [1] manual cleanup/retry (default), [2] auto-stash worktree changes and retry merge: ',
      )).trim().toLowerCase();
      if (answer === '' || answer === '1' || answer === 'm' || answer === 'manual') {
        return MergeRecoveryAction.Stop;
      }
      if (answer === '2' || answer === 's' || answer === 'stash' || answer === 'auto-stash') {
        return MergeRecoveryAction.StashAndRetry;
      }
      console.error('  Enter 1 for manual cleanup/retry, or 2 to auto-stash and retry merge.');
    }
  } finally {
    rl.close();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let parseResult: any;
try {
  parseResult = await parseArgs({
    allowPositionals: true,
    options: {
    repo:   { type: 'string', default: '' },
    'state-root': { type: 'string', default: '' },
    tasks:  { type: 'string', default: '' },
    loop:   { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    graph:  { type: 'boolean', default: false },
    check:  { type: 'boolean', default: false },
    agent:  { type: 'string', default: '' },
    model:  { type: 'string', default: '' },
    reasoning: { type: 'string', default: '' },
    stop:   { type: 'boolean', default: false },
    task:   { type: 'string', short: 't', default: '' },
    unblock: { type: 'string', default: '' },
    goal:   { type: 'string', default: '' },
    metric: { type: 'string', default: '' },
    scope:  { type: 'string', default: '' },
    once:   { type: 'boolean', default: false },
    config: { type: 'boolean', default: false },
    'keep-alive': { type: 'boolean', default: false },
    'keep-converged': { type: 'string', default: '' },
    infinite: { type: 'boolean', default: false },
    'auto-stash': { type: 'boolean', default: false },
    'no-worktree': { type: 'boolean', default: false },
    parallel: { type: 'string', default: '' },
    worktrees: { type: 'string', default: '' },
    help:   { type: 'boolean', short: 'h', default: false },
  },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} catch (e: unknown) {
  console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}`);
  console.error('  Run orchestrator --help for usage.\n');
  process.exit(1);
}
const { values, positionals } = parseResult!;

if (values.help) {
  console.log(formatHelp(appVersion(), {
    agent: env.agent,
    model: env.model ?? '',
    reasoning: env.reasoning ?? '',
    parallel: env.parallelTasks,
    converge: env.converge,
    maxFailures: env.maxFailures === Infinity ? 'infinite' : String(env.maxFailures),
    autoStash: env.autoStash,
    noWorktree: env.noWorktree,
    logLevel: env.logLevel,
  }));
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
  console.error('  Example: orchestrator --repo /path/to/your/repo\n');
  process.exit(1);
}

const repo = paths.repo;
const dir = paths.tasks;
const worktreesDir = paths.worktrees;
const autoStash = values['auto-stash'] || env.autoStash;
const noWorktree = values['no-worktree'] || env.noWorktree;
const keepAlive = values['keep-alive'] || env.keepAlive;
const infinite = values.infinite || values.loop || env.infinite;

// Parse parallel value: CLI flag > env var > default
let parallel = env.parallelTasks;
if (values.parallel) {
   const parsed = parseInt(values.parallel, 10);
   if (!Number.isFinite(parsed) || parsed < 0) {
     console.warn(`⚠️  --parallel must be 0-100; received '${values.parallel}', using default: 1`);
   } else if (parsed > 100) {
     console.warn(`⚠️  --parallel clamped to 100 (received: ${parsed})`);
     parallel = 100;
   } else {
     parallel = parsed;
   }
}

const keepConverged = values['keep-converged'] ? parseInt(values['keep-converged'] as string, 10) : undefined;

let agent: CodingAgent;
try {
  agent = createCodingAgent(values.agent || env.agent, {
    ...(values.reasoning ? { reasoning: values.reasoning } : {}),
    ...(values.model ? { model: values.model } : {}),
    workDir: repo,
  });
} catch (e: unknown) {
  console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

console.log(`repo: ${repo}`);
console.log(`tasks: ${dir}`);
console.log(`worktrees: ${worktreesDir}`);
console.log(`agent: ${agent.name}`);

if (values.config) {
  console.log(formatEffectiveConfig(values as Record<string, unknown>, process.env));
  console.log('\nResolved paths');
  console.log(`  repo:       ${paths.repo}`);
  console.log(`  state root: ${paths.stateRoot}`);
  console.log(`  tasks:      ${paths.tasks}`);
  console.log(`  worktrees:  ${paths.worktrees}`);
  console.log('\n--check validates prerequisites and reports auth hints; runtime still validates agent auth.');
  process.exit(0);
}

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
  const task = engine.pickByNumber(tn);
  if (!task) { console.error(`T${tn} not found`); process.exit(1); }
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ar = readFileSync(join(task.directory, 'autoresearch.md'), 'utf-8');
  let updated = ar;
  if (values.goal) updated = updated.replace(/^## Goal.*$/m, `## Goal: ${values.goal}`);
  if (values.metric) updated = updated.replace(/\`[^`]+\` — task-specific deliverable/, `\`${values.metric}\` — task-specific deliverable`);
  if (values.scope) {
    const lines = (values.scope as string).split(/\s+/).map((f: string) => `- ${f}`).join('\n');
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
  const results = await Prerequisites.check(agent);
  console.log(Prerequisites.format(results));
  process.exit(results.every(r => r.ok) ? 0 : 1);
}


if (values.status) {
  const tdb = TaskDb.open(resolve(dir, 'state.db'));
  try {
    const all = TaskState.scan(tdb, dir);
    const nums = [...all.keys()].map(Number).sort((a, b) => a - b);
    console.log('');
    for (const k of nums) {
      const t = all.get(String(k));
      if (!t) continue;
      let label = 'UNKNOWN';
      if (t.isConverged) label = 'CONVERGED';
      else if (t.isFailed) label = 'FAILED';
      else if (t.isBlocked) label = 'BLOCKED';
      else if (t.isPending) label = 'PENDING';
      else if (t.isInProgress) label = 'RUNNING';
      const deps = t.dependencies.length > 0 ? `  <- depends: ${t.dependencies.join(', ')}` : '';
      const goal = t.goal.length > 55 ? t.goal.slice(0, 52) + '...' : t.goal;
      console.log(`  ${label.padEnd(9)} T${k}  ${goal}${deps}`);
      if (t.isBlocked) {
        console.log(`       blocked after ${t.failureCount} failures`);
      }
    }
    console.log(`  -- ${all.size} total\n`);
  } finally {
    tdb.close();
  }
  process.exit(0);
}

if (values.graph) {
  const tdb = TaskDb.open(resolve(dir, 'state.db'));
  try {
    const nodes: GraphNode[] = [];
    // Read every status (including converged) so the full DAG is shown.
    for (const row of tdb.byStatus(['PENDING', 'IN_PROGRESS', 'FAILED', 'BLOCKED', 'CONVERGED'])) {
      const t = TaskState.fromRow(tdb, dir, row);
      const status = row.status === 'IN_PROGRESS' ? 'running' : row.status.toLowerCase();
      nodes.push({ number: t.taskNumber, status, goal: t.goal, deps: [...t.dependencies] });
    }
    console.log('');
    for (const line of formatTaskGraph(nodes)) console.log(line);
    console.log('');
  } finally {
    tdb.close();
  }
  process.exit(0);
}

// Quick prerequisite check before running
const prereqs = await Prerequisites.check(agent);
const failed = prereqs.filter(r => !r.ok);
if (failed.length > 0) {
  console.error(Prerequisites.format(prereqs));
  process.exit(1);
}

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

const engine = new Engine(dir, {
  repoDir: repo,
  worktreesDir,
  noWorktree,
  autoStashBeforeMerge: autoStash,
  mergeRecovery: autoStash ? () => MergeRecoveryAction.StashAndRetry : promptMergeRecovery,
  verifyCmd: 'npm run tc',
  parallel,
  ...(keepConverged !== undefined ? { keepConverged } : {}),
  infinite,
  spawn: (task, worktreePath, signal) => agent.spawn(task, worktreePath, signal),
  benchmark: async (t: TaskInfo) => {
    // Engine sets t.cwd to the worktree (post-agent / pre-merge checks) or the
    // repo (initial check). Run the task's benchmark.js from there so it measures
    // the right tree regardless of where the task directory lives.
    const reasonPath = resolve(t.directory, 'benchmark.log');
    let out: string;
    let crashed = false;
    try {
      out = execFileSync(process.execPath, [resolve(t.directory, 'benchmark.js')], {
        timeout: env.benchmarkTimeoutMs, encoding: 'utf-8', cwd: t.cwd,
      });
    } catch (e: unknown) {
      // A non-zero exit, timeout, or spawn error makes the result unreliable —
      // capture whatever printed before the crash so the reason is never lost.
      crashed = true;
      const err = e as { stdout?: string; stderr?: string; message?: string };
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || (err.message ?? 'benchmark execution failed');
    }
    try {
      writeFileSync(reasonPath, out);
    } catch (e: unknown) {
      console.warn(`⚠️  Could not write benchmark log ${reasonPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const outcome = classifyBenchmark(out, crashed, t.metrics);
    if (outcome.kind !== 'ok' || outcome.total > 0) {
      const summary = outcome.kind === 'crash'
        ? 'benchmark crashed (see log)'
        : outcome.kind === 'no_metrics'
          ? `no METRIC lines emitted (treated as ${outcome.total})`
          : unmetSummary(outcome);
      console.log(`T${t.number} unmet: ${summary}`);
      console.log(`  why: ${reasonPath}`);
    }
    // Hand the Engine the full structured outcome so a crash / no-METRIC run is
    // never mistaken for ordinary "work remaining".
    return outcome;
  },
});

// Reset blocked/failed task(s) back to pending (no --stop needed; loop-safe
// because blocked tasks are terminal — nobody is processing them).
if (values.unblock) {
  if (values.unblock.toLowerCase() === 'all') {
    const blocked = [...TaskState.scan(engine.taskDb, dir).values()].filter(t => t.isBlocked);
    if (blocked.length === 0) { console.log('No blocked tasks to unblock.'); process.exit(0); }
    for (const t of blocked) t.unblock();
    console.log(`Unblocked ${blocked.length} task(s) → PENDING: ${blocked.map(t => `T${t.taskNumber}`).join(', ')}. They will be picked up on the next tick.`);
    process.exit(0);
  }
  const tn = parseInt(values.unblock, 10);
  if (isNaN(tn)) { console.error('Invalid task number (use a number or "all")'); process.exit(1); }
  const task = engine.pickByNumber(tn);
  if (!task) { console.error(`T${tn} not found`); process.exit(1); }
  if (task.isConverged) { console.error(`T${tn} is CONVERGED; nothing to unblock`); process.exit(1); }
  task.unblock();
  console.log(`T${tn} unblocked → PENDING (claim cleared, failures reset); it will be picked up on the next tick.`);
  process.exit(0);
}

// Force-pick a specific task by number
if (values.task) {
  const tn = parseInt(values.task, 10);
  if (isNaN(tn)) { console.error('Invalid task number'); process.exit(1); }
  const task = engine.pickByNumber(tn);
  if (!task) { console.error(`T${tn} not found`); process.exit(1); }
  try {
    const out = execFileSync(process.execPath, [resolve(task.directory, 'benchmark.js')], { timeout: env.benchmarkTimeoutMs, encoding: 'utf-8', cwd: repo });
    const metric = parseMetrics(out, 1, task.metricNames).total;
    console.log(`${metric === 0 ? '⏳' : '❌'} T${tn}: ${task.goal.slice(0, 60)} (metric=${metric})`);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.log(`❌ T${tn}: benchmark failed (${reason})`);
  }
  process.exit(0);
}

try {
  if (values.once) {
    const r = await engine.tick();
    if (engine.environmentError) {
      console.error(`\n  ❌ Environment issue: ${engine.environmentError}`);
      console.error('  Stopped without consuming any task retries. Fix the environment (e.g. set the API key) and rerun.\n');
      process.exit(1);
    }
    if (r.task) {
      const icon = r.converged ? '✅' : r.metric === 0 ? '⏳' : '❌';
      console.log(`${icon} T${r.task.number}: metric=${r.metric}`);
    } else {
      console.log('Nothing actionable.');
    }
  } else {
    console.log(infinite ? 'Running in infinite mode; stop with --stop' : 'Running until tasks complete');
    const n = await engine.loop({
      onTick: async (r, total) => {
        if (r.task) {
          const icon = r.converged ? '✅' : r.metric === 0 ? '⏳' : '❌';
          const status = r.converged ? 'converged' : r.metric === 0 ? 'convergence pending' : `metric=${r.metric}`;
          console.log(`  ${icon} T${r.task.number}: ${status} — ${r.task.goal.slice(0, 60)}`);
        }
        await printOverview(dir, total);
      },
      keepAlive,
      infinite,
    });
    if (engine.environmentError) {
      await printRunSummary(dir, n);
      console.error(`\n  ❌ Fatal: ${engine.environmentError}`);
      console.error('  The loop stopped because this affects every task (not a single-task failure).');
      console.error('  No task retries were consumed — fix the cause and rerun.\n');
      process.exit(1);
    }
    await printRunSummary(dir, n);
    if (engine.stopReason === 'signal') {
      console.log(`\n🛑 Stopped by stop signal (--stop / .stop) after ${n} ticks.\n`);
    } else if (infinite) {
      console.log(`\n🛑 stopped after ${n} ticks\n`);
    } else {
      console.log(`\n🎉 ${n} ticks — all done\n`);
    }
  }
} catch (e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`\n  ❌ ${message}\n`);
  process.exit(1);
}
