#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { createInterface } from 'node:readline/promises';
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

const CLI_PARSE_CONFIG = {
  allowPositionals: true,
  options: CLI_OPTIONS,
} as const satisfies ParseArgsConfig;

type CliOptionValues = Readonly<{
  repo: string;
  'state-root': string;
  tasks: string;
  loop: boolean;
  status: boolean;
  graph: boolean;
  check: boolean;
  agent: string;
  model: string;
  reasoning: string;
  stop: boolean;
  task: string;
  unblock: string;
  goal: string;
  metric: string;
  scope: string;
  once: boolean;
  config: boolean;
  'keep-alive': boolean;
  'keep-converged': string;
  infinite: boolean;
  'auto-stash': boolean;
  'no-worktree': boolean;
  parallel: string;
  worktrees: string;
  help: boolean;
}>;

type CliArgs = {
  values: CliOptionValues;
  positionals: string[];
};
type CliValues = CliArgs['values'];
type CliPositionals = CliArgs['positionals'];
type ResolvedPaths = ReturnType<typeof resolveCliPaths>;
type RuntimeOptions = {
  repo: string;
  tasksDir: string;
  worktreesDir: string;
  autoStash: boolean;
  noWorktree: boolean;
  keepAlive: boolean;
  infinite: boolean;
  parallel: number;
  keepConverged: number | undefined;
};
type TaskLabel = 'CONVERGED' | 'FAILED' | 'BLOCKED' | 'PENDING' | 'RUNNING' | 'UNKNOWN';

type TaskLabelMatcher = {
  readonly label: TaskLabel;
  readonly matches: (task: TaskState) => boolean;
};

const TASK_LABELS: readonly TaskLabelMatcher[] = [
  { label: 'CONVERGED', matches: task => task.isConverged },
  { label: 'FAILED', matches: task => task.isFailed },
  { label: 'BLOCKED', matches: task => task.isBlocked },
  { label: 'PENDING', matches: task => task.isPending },
  { label: 'RUNNING', matches: task => task.isInProgress },
] as const;

function readStringOption(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value : '';
}

function readBooleanOption(value: string | boolean | undefined): boolean {
  return value === true;
}

function parseCliArgsInternal(): CliArgs {
  const parsed = parseArgs(CLI_PARSE_CONFIG);
  return {
    positionals: [...parsed.positionals],
    values: {
      repo: readStringOption(parsed.values.repo),
      'state-root': readStringOption(parsed.values['state-root']),
      tasks: readStringOption(parsed.values.tasks),
      loop: readBooleanOption(parsed.values.loop),
      status: readBooleanOption(parsed.values.status),
      graph: readBooleanOption(parsed.values.graph),
      check: readBooleanOption(parsed.values.check),
      agent: readStringOption(parsed.values.agent),
      model: readStringOption(parsed.values.model),
      reasoning: readStringOption(parsed.values.reasoning),
      stop: readBooleanOption(parsed.values.stop),
      task: readStringOption(parsed.values.task),
      unblock: readStringOption(parsed.values.unblock),
      goal: readStringOption(parsed.values.goal),
      metric: readStringOption(parsed.values.metric),
      scope: readStringOption(parsed.values.scope),
      once: readBooleanOption(parsed.values.once),
      config: readBooleanOption(parsed.values.config),
      'keep-alive': readBooleanOption(parsed.values['keep-alive']),
      'keep-converged': readStringOption(parsed.values['keep-converged']),
      infinite: readBooleanOption(parsed.values.infinite),
      'auto-stash': readBooleanOption(parsed.values['auto-stash']),
      'no-worktree': readBooleanOption(parsed.values['no-worktree']),
      parallel: readStringOption(parsed.values.parallel),
      worktrees: readStringOption(parsed.values.worktrees),
      help: readBooleanOption(parsed.values.help),
    },
  };
}

async function promptMergeRecovery(failure: MergeRecoveryFailure): Promise<MergeRecoveryAction> {
  console.error('');
  console.error(`  ⚠️  T${failure.task.number} could not merge ${failure.branch}`);
  console.error(`  worktree: ${failure.worktreePath}`);
  console.error(`  reason: ${failure.error}`);
  console.error('  NOTE: "Your local changes" refers to uncommitted edits in the WORKTREE (the agent\'s work), not the main repo.');
  if (!process.stdin.isTTY) {
    console.error('  Non-interactive shell: blocking the task and keeping the worktree for inspection.');
    return MergeRecoveryAction.Stop;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
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

function parseCliArgs(): CliArgs {
  try {
    return parseCliArgsInternal();
  } catch (e: unknown) {
    console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}`);
    console.error('  Run orchestrator --help for usage.\n');
    process.exit(1);
  }
}

function resolveCliPaths(values: CliValues) {
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

function parseOptionalInteger(flag: string, value: string): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`⚠️  ${flag} must be a number; received '${value}', ignoring`);
    return undefined;
  }
  return parsed;
}

function normalizeRuntimeOptions(values: CliValues, paths: ResolvedPaths): RuntimeOptions {
  const parallel = values.parallel ? parseParallel(values.parallel, env.parallelTasks) : env.parallelTasks;

  return {
    repo: paths.repo,
    tasksDir: paths.tasks,
    worktreesDir: paths.worktrees,
    autoStash: values['auto-stash'] || env.autoStash,
    noWorktree: values['no-worktree'] || env.noWorktree,
    keepAlive: values['keep-alive'] || env.keepAlive,
    infinite: values.infinite || values.loop || env.infinite,
    parallel,
    keepConverged: parseOptionalInteger('--keep-converged', values['keep-converged']),
  };
}

function detectLineBreak(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function splitSectionBody(body: string): string[] {
  return body.split(/\r?\n/);
}

function findSectionRange(lines: readonly string[], heading: string): readonly [number, number] | undefined {
  const header = `## ${heading}`;
  const start = lines.findIndex(line => line === header || line.startsWith(`${header}:`));
  if (start === -1) return undefined;

  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]!)) end++;
  return [start, end];
}

function countTrailingBlankLines(lines: readonly string[], start: number, end: number): number {
  let count = 0;
  for (let index = end - 1; index > start && lines[index] === ''; index--) count++;
  return count;
}

function replaceSection(content: string, heading: string, bodyLines: readonly string[]): string {
  const lineBreak = detectLineBreak(content);
  const lines = content.split(/\r?\n/);
  const range = findSectionRange(lines, heading);
  if (!range) return content;

  const [start, end] = range;
  const trailingBlankLines = countTrailingBlankLines(lines, start, end);
  return [
    ...lines.slice(0, start),
    `## ${heading}`,
    ...bodyLines,
    ...Array.from({ length: trailingBlankLines }, () => ''),
    ...lines.slice(end),
  ].join(lineBreak);
}

function normalizeScope(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean).map(file => `- ${file}`);
}

function updateAutoresearch(content: string, values: CliValues): string {
  let updated = content;
  if (values.goal) {
    updated = replaceSection(updated, 'Goal', splitSectionBody(values.goal));
  }
  if (values.metric) {
    updated = updated.replace(/\`[^`]+\` — task-specific deliverable/, `\`${values.metric}\` — task-specific deliverable`);
  }
  if (values.scope) {
    updated = replaceSection(updated, 'Scope', normalizeScope(values.scope));
  }
  return updated;
}

function taskLabel(task: TaskState): TaskLabel {
  return TASK_LABELS.find(entry => entry.matches(task))?.label ?? 'UNKNOWN';
}

function parseTaskNumber(value: string | undefined, usage: string): number {
  const taskNumber = parseInt(value ?? '', 10);
  if (Number.isNaN(taskNumber)) {
    console.error(usage);
    process.exit(1);
  }
  return taskNumber;
}

function pickTaskOrExit(engine: Engine, taskNumber: number): TaskState {
  const task = engine.pickByNumber(taskNumber);
  if (!task) {
    console.error(`T${taskNumber} not found`);
    process.exit(1);
  }
  return task;
}

function printPathsAndAgent(paths: ResolvedPaths, agent: CodingAgent): void {
  console.log(`repo: ${paths.repo}`);
  console.log(`tasks: ${paths.tasks}`);
  console.log(`worktrees: ${paths.worktrees}`);
  console.log(`agent: ${agent.name}`);
}

function taskAutoresearchPath(task: Pick<TaskInfo, 'directory'>): string {
  return join(task.directory, 'autoresearch.md');
}

function taskBenchmarkPath(task: Pick<TaskInfo, 'directory'>): string {
  return resolve(task.directory, 'benchmark.js');
}

function taskBenchmarkLogPath(task: Pick<TaskInfo, 'directory'>): string {
  return resolve(task.directory, 'benchmark.log');
}

function buildAddTaskOptions(values: CliValues): Record<string, string | string[]> {
  const options: Record<string, string | string[]> = {};
  if (values.goal) options.goal = values.goal;
  if (values.metric) options.metric = values.metric;
  if (values.scope) options.scope = values.scope.split(/\s+/).filter(Boolean);
  return options;
}

function handleEditCommand(positionals: CliPositionals, values: CliValues, tasksDir: string, repo: string): void {
  if (positionals[0] !== 'edit') return;

  const taskNumber = parseTaskNumber(positionals[1], 'Usage: orchestrator edit <n> [--goal ...] [--metric ...] [--scope ...]');
  const engine = new Engine(tasksDir, { repoDir: repo });
  const task = pickTaskOrExit(engine, taskNumber);
  const autoresearchPath = taskAutoresearchPath(task);
  const updated = updateAutoresearch(readFileSync(autoresearchPath, 'utf-8'), values);
  writeFileSync(autoresearchPath, updated);
  console.log(`✅ T${taskNumber} updated`);
  process.exit(0);
}

function handleAddCommand(positionals: CliPositionals, values: CliValues, tasksDir: string): void {
  if (positionals[0] !== 'add') return;

  const name = positionals[1];
  if (!name) {
    console.error('Usage: orchestrator add <name> [--goal ...] [--metric ...] [--scope ...]');
    process.exit(1);
  }

  const result = addTask(tasksDir, name, buildAddTaskOptions(values));
  console.log(`✅ T${result.number} added: ${name}`);
  console.log(`   ${result.directory}`);
  console.log('   Next: edit autoresearch.md + benchmark.js, then npm run tick');
  process.exit(0);
}

function handleStatusCommand(enabled: boolean, tasksDir: string): void {
  if (!enabled) return;

  const tdb = TaskDb.open(resolve(tasksDir, 'state.db'));
  try {
    const all = TaskState.scan(tdb, tasksDir);
    const nums = [...all.keys()].map(Number).sort((a, b) => a - b);
    console.log('');
    for (const key of nums) {
      const task = all.get(String(key));
      if (!task) continue;
      const deps = task.dependencies.length > 0 ? `  <- depends: ${task.dependencies.join(', ')}` : '';
      const goal = task.goal.length > 55 ? `${task.goal.slice(0, 52)}...` : task.goal;
      console.log(`  ${taskLabel(task).padEnd(9)} T${key}  ${goal}${deps}`);
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

function handleGraphCommand(enabled: boolean, tasksDir: string): void {
  if (!enabled) return;

  const tdb = TaskDb.open(resolve(tasksDir, 'state.db'));
  try {
    const nodes: GraphNode[] = [];
    for (const row of tdb.byStatus(['PENDING', 'IN_PROGRESS', 'FAILED', 'BLOCKED', 'CONVERGED'])) {
      const task = TaskState.fromRow(tdb, tasksDir, row);
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

function ensureRepoExists(repo: string): void {
  if (existsSync(repo)) return;
  console.error(`\n  ❌ Repo folder not found: ${repo}\n`);
  process.exit(1);
}

function ensureTasksDirExists(tasksDir: string): void {
  if (existsSync(tasksDir)) return;
  console.error(`\n  ❌ Tasks directory not found: ${tasksDir}`);
  console.error('  Create it with the add command, or pass --tasks / ORCH_TASKS to an existing task folder.\n');
  process.exit(1);
}

function printTickOutcome(result: { task: TaskInfo | null; converged: boolean; metric: number }): void {
  if (!result.task) return;
  const icon = result.converged ? '✅' : result.metric === 0 ? '⏳' : '❌';
  const status = result.converged ? 'converged' : result.metric === 0 ? 'convergence pending' : `metric=${result.metric}`;
  console.log(`  ${icon} T${result.task.number}: ${status} — ${result.task.goal.slice(0, 60)}`);
}

function handleUnblockCommand(engine: Engine, tasksDir: string, unblock: string): void {
  if (!unblock) return;

  if (unblock.toLowerCase() === 'all') {
    const blocked = [...TaskState.scan(engine.taskDb, tasksDir).values()].filter(task => task.isBlocked);
    if (blocked.length === 0) {
      console.log('No blocked tasks to unblock.');
      process.exit(0);
    }
    for (const task of blocked) task.unblock();
    console.log(`Unblocked ${blocked.length} task(s) → PENDING: ${blocked.map(task => `T${task.taskNumber}`).join(', ')}. They will be picked up on the next tick.`);
    process.exit(0);
  }

  const taskNumber = parseTaskNumber(unblock, 'Invalid task number (use a number or "all")');
  const task = pickTaskOrExit(engine, taskNumber);
  if (task.isConverged) {
    console.error(`T${taskNumber} is CONVERGED; nothing to unblock`);
    process.exit(1);
  }
  task.unblock();
  console.log(`T${taskNumber} unblocked → PENDING (claim cleared, failures reset); it will be picked up on the next tick.`);
  process.exit(0);
}

function handleTaskCommand(engine: Engine, taskValue: string, repo: string): void {
  if (!taskValue) return;

  const taskNumber = parseTaskNumber(taskValue, 'Invalid task number');
  const task = pickTaskOrExit(engine, taskNumber);
  try {
    const out = execFileSync(process.execPath, [taskBenchmarkPath(task)], {
      timeout: env.benchmarkTimeoutMs,
      encoding: 'utf-8',
      cwd: repo,
    });
    const metric = parseMetrics(out, 1, task.metricNames).total;
    console.log(`${metric === 0 ? '⏳' : '❌'} T${taskNumber}: ${task.goal.slice(0, 60)} (metric=${metric})`);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.log(`❌ T${taskNumber}: benchmark failed (${reason})`);
  }
  process.exit(0);
}

function createAgent(values: CliValues, runtime: RuntimeOptions): CodingAgent {
  try {
    return createCodingAgent(values.agent || env.agent, {
      ...(values.reasoning ? { reasoning: values.reasoning } : {}),
      ...(values.model ? { model: values.model } : {}),
      workDir: runtime.repo,
    });
  } catch (e: unknown) {
    console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

function handleConfigCommand(enabled: boolean, values: CliValues, paths: ResolvedPaths): void {
  if (!enabled) return;

  console.log(formatEffectiveConfig({ ...values }, process.env));
  console.log('\nResolved paths');
  console.log(`  repo:       ${paths.repo}`);
  console.log(`  state root: ${paths.stateRoot}`);
  console.log(`  tasks:      ${paths.tasks}`);
  console.log(`  worktrees:  ${paths.worktrees}`);
  console.log('\n--check validates prerequisites and reports auth hints; runtime still validates agent auth.');
  process.exit(0);
}

async function handleCheckCommand(enabled: boolean, agent: CodingAgent): Promise<void> {
  if (!enabled) return;

  const results = await Prerequisites.check(agent);
  console.log(Prerequisites.format(results));
  process.exit(results.every(result => result.ok) ? 0 : 1);
}

async function ensureAgentPrerequisites(agent: CodingAgent): Promise<void> {
  const prereqs = await Prerequisites.check(agent);
  const failed = prereqs.filter(result => !result.ok);
  if (failed.length === 0) return;
  console.error(Prerequisites.format(prereqs));
  process.exit(1);
}

function createEngine(runtime: RuntimeOptions, agent: CodingAgent): Engine {
  return new Engine(runtime.tasksDir, {
    repoDir: runtime.repo,
    worktreesDir: runtime.worktreesDir,
    noWorktree: runtime.noWorktree,
    autoStashBeforeMerge: runtime.autoStash,
    mergeRecovery: runtime.autoStash ? () => MergeRecoveryAction.StashAndRetry : promptMergeRecovery,
    verifyCmd: 'npm run tc',
    parallel: runtime.parallel,
    ...(runtime.keepConverged !== undefined ? { keepConverged: runtime.keepConverged } : {}),
    infinite: runtime.infinite,
    spawn: (task, worktreePath, signal) => agent.spawn(task, worktreePath, signal),
    benchmark: async (task: TaskInfo) => {
      const reasonPath = taskBenchmarkLogPath(task);
      let out: string;
      let crashed = false;
      try {
        out = execFileSync(process.execPath, [taskBenchmarkPath(task)], {
          timeout: env.benchmarkTimeoutMs,
          encoding: 'utf-8',
          cwd: task.cwd,
        });
      } catch (e: unknown) {
        crashed = true;
        const err = e as { stdout?: string; stderr?: string; message?: string };
        out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || (err.message ?? 'benchmark execution failed');
      }
      try {
        writeFileSync(reasonPath, out);
      } catch (e: unknown) {
        console.warn(`⚠️  Could not write benchmark log ${reasonPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const outcome = classifyBenchmark(out, crashed, task.metrics);
      if (outcome.kind !== 'ok' || outcome.total > 0) {
        const summary = outcome.kind === 'crash'
          ? 'benchmark crashed (see log)'
          : outcome.kind === 'no_metrics'
            ? `no METRIC lines emitted (treated as ${outcome.total})`
            : unmetSummary(outcome);
        console.log(`T${task.number} unmet: ${summary}`);
        console.log(`  why: ${reasonPath}`);
      }
      return outcome;
    },
  });
}

async function runOnce(engine: Engine): Promise<void> {
  const result = await engine.tick();
  if (engine.environmentError) {
    console.error(`\n  ❌ Environment issue: ${engine.environmentError}`);
    console.error('  Stopped without consuming any task retries. Fix the environment (e.g. set the API key) and rerun.\n');
    process.exit(1);
  }
  if (result.task) {
    const icon = result.converged ? '✅' : result.metric === 0 ? '⏳' : '❌';
    console.log(`${icon} T${result.task.number}: metric=${result.metric}`);
    return;
  }
  console.log('Nothing actionable.');
}

async function runLoop(engine: Engine, runtime: RuntimeOptions): Promise<void> {
  console.log(runtime.infinite ? 'Running in infinite mode; stop with --stop' : 'Running until tasks complete');
  const tickCount = await engine.loop({
    onTick: async (result, total) => {
      printTickOutcome(result);
      await printOverview(runtime.tasksDir, total);
    },
    keepAlive: runtime.keepAlive,
    infinite: runtime.infinite,
  });
  if (engine.environmentError) {
    await printRunSummary(runtime.tasksDir, tickCount);
    console.error(`\n  ❌ Fatal: ${engine.environmentError}`);
    console.error('  The loop stopped because this affects every task (not a single-task failure).');
    console.error('  No task retries were consumed — fix the cause and rerun.\n');
    process.exit(1);
  }
  await printRunSummary(runtime.tasksDir, tickCount);
  if (engine.stopReason === 'signal') {
    console.log(`\n🛑 Stopped by stop signal (--stop / .stop) after ${tickCount} ticks.\n`);
  } else if (runtime.infinite) {
    console.log(`\n🛑 stopped after ${tickCount} ticks\n`);
  } else {
    console.log(`\n🎉 ${tickCount} ticks — all done\n`);
  }
}

async function runEngine(engine: Engine, runtime: RuntimeOptions, once: boolean): Promise<void> {
  try {
    if (once) {
      await runOnce(engine);
      return;
    }
    await runLoop(engine, runtime);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`\n  ❌ ${message}\n`);
    process.exit(1);
  }
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
const runtime = normalizeRuntimeOptions(values, paths);

const agent = createAgent(values, runtime);

printPathsAndAgent(paths, agent);
handleConfigCommand(values.config, values, paths);

ensureRepoExists(runtime.repo);
mkdirSync(paths.stateRoot, { recursive: true });
mkdirSync(runtime.worktreesDir, { recursive: true });

handleEditCommand(positionals, values, runtime.tasksDir, runtime.repo);
handleAddCommand(positionals, values, runtime.tasksDir);

await handleCheckCommand(values.check, agent);

handleStatusCommand(values.status, runtime.tasksDir);
handleGraphCommand(values.graph, runtime.tasksDir);

await ensureAgentPrerequisites(agent);

if (values.stop) {
  writeFileSync(resolve(runtime.tasksDir, '.stop'), '');
  console.log('Stop signal sent.');
  process.exit(0);
}

ensureTasksDirExists(runtime.tasksDir);

const engine = createEngine(runtime, agent);

handleUnblockCommand(engine, runtime.tasksDir, values.unblock);
handleTaskCommand(engine, values.task, runtime.repo);

await runEngine(engine, runtime, values.once);
