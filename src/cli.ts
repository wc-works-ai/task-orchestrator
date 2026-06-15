#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const CLI_OPTIONS = {
  repo: { type: 'string', default: '' },
  'state-root': { type: 'string', default: '' },
  tasks: { type: 'string', default: '' },
  loop: { type: 'boolean', default: false },
  status: { type: 'boolean', default: false },
  graph: { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  agent: { type: 'string', default: '' },
  model: { type: 'string', default: '' },
  reasoning: { type: 'string', default: '' },
  stop: { type: 'boolean', default: false },
  task: { type: 'string', short: 't', default: '' },
  unblock: { type: 'string', default: '' },
  goal: { type: 'string', default: '' },
  metric: { type: 'string', default: '' },
  scope: { type: 'string', default: '' },
  once: { type: 'boolean', default: false },
  config: { type: 'boolean', default: false },
  'keep-alive': { type: 'boolean', default: false },
  'keep-converged': { type: 'string', default: '' },
  infinite: { type: 'boolean', default: false },
  'auto-stash': { type: 'boolean', default: false },
  'no-worktree': { type: 'boolean', default: false },
  parallel: { type: 'string', default: '' },
  worktrees: { type: 'string', default: '' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

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

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: CLI_OPTIONS,
    });
  } catch (e: unknown) {
    console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}`);
    console.error('  Run orchestrator --help for usage.\n');
    process.exit(1);
  }
}

function resolveCliPaths(values: ReturnType<typeof parseCliArgs>['values']) {
  try {
    return resolveStatePaths({
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
}

function parseParallel(value: string, fallback: number): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`⚠️  --parallel must be 0-100; received '${value}', using default: ${fallback}`);
    return fallback;
  }
  if (parsed > 100) {
    console.warn(`⚠️  --parallel clamped to 100 (received: ${parsed})`);
    return 100;
  }
  return parsed;
}

function splitSectionBody(body: string): string[] {
  return body.split(/\r?\n/);
}

function replaceSection(content: string, heading: string, bodyLines: readonly string[]): string {
  const header = `## ${heading}`;
  const lines = content.split('\n');
  const start = lines.findIndex(line => line === header || line.startsWith(`${header}:`));
  if (start === -1) return content;

  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith('## ')) end++;

  const updated = [
    ...lines.slice(0, start),
    header,
    ...bodyLines,
    ...lines.slice(end),
  ].join('\n');
  return content.endsWith('\n') && !updated.endsWith('\n') ? `${updated}\n` : updated;
}

function updateAutoresearch(content: string, values: ReturnType<typeof parseCliArgs>['values']): string {
  let updated = content;
  if (values.goal) {
    updated = replaceSection(updated, 'Goal', splitSectionBody(values.goal));
  }
  if (values.metric) {
    updated = updated.replace(/\`[^`]+\` — task-specific deliverable/, `\`${values.metric}\` — task-specific deliverable`);
  }
  if (values.scope) {
    updated = replaceSection(updated, 'Scope', values.scope.split(/\s+/).map(file => `- ${file}`));
  }
  return updated;
}

function taskLabel(task: TaskState): string {
  if (task.isConverged) return 'CONVERGED';
  if (task.isFailed) return 'FAILED';
  if (task.isBlocked) return 'BLOCKED';
  if (task.isPending) return 'PENDING';
  if (task.isInProgress) return 'RUNNING';
  return 'UNKNOWN';
}

const { values, positionals } = parseCliArgs();

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

const paths = resolveCliPaths(values);
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
  parallel = parseParallel(values.parallel, parallel);
}

const keepConverged = values['keep-converged'] ? parseInt(values['keep-converged'], 10) : undefined;

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
  const autoresearchPath = join(task.directory, 'autoresearch.md');
  const updated = updateAutoresearch(readFileSync(autoresearchPath, 'utf-8'), values);
  writeFileSync(autoresearchPath, updated);
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
      const task = all.get(String(k));
      if (!task) continue;
      const label = taskLabel(task);
      const deps = task.dependencies.length > 0 ? `  <- depends: ${task.dependencies.join(', ')}` : '';
      const goal = task.goal.length > 55 ? `${task.goal.slice(0, 52)}...` : task.goal;
      console.log(`  ${label.padEnd(9)} T${k}  ${goal}${deps}`);
      if (task.isBlocked) {
        console.log(`       blocked after ${task.failureCount} failures`);
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
      const task = TaskState.fromRow(tdb, dir, row);
      const status = row.status === 'IN_PROGRESS' ? 'running' : row.status.toLowerCase();
      nodes.push({ number: task.taskNumber, status, goal: task.goal, deps: [...task.dependencies] });
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
    const blocked = [...TaskState.scan(engine.taskDb, dir).values()].filter(task => task.isBlocked);
    if (blocked.length === 0) { console.log('No blocked tasks to unblock.'); process.exit(0); }
    for (const task of blocked) task.unblock();
    console.log(`Unblocked ${blocked.length} task(s) → PENDING: ${blocked.map(task => `T${task.taskNumber}`).join(', ')}. They will be picked up on the next tick.`);
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
