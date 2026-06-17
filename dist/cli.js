#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { join, resolve, basename } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { addTask } from './state/addTask.js';
import { Engine, MergeRecoveryAction } from './engine/Engine.js';
import { TaskState } from './state/TaskState.js';
import { TaskDb } from './state/TaskDb.js';
import { createCodingAgent } from './agent/agents.js';
import { Prerequisites } from './agent/Prerequisites.js';
import { env } from './shared/env.js';
import { resolveStatePaths } from './state/StatePaths.js';
import { printOverview, printRunSummary } from './engine/runReport.js';
import { parseMetrics, unmetSummary, classifyBenchmark } from './shared/metrics.js';
import { formatTaskGraph } from './engine/taskGraph.js';
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
    priority: { type: 'string', default: '' },
    help: { type: 'boolean', short: 'h', default: false },
};
const CLI_PARSE_CONFIG = {
    allowPositionals: true,
    options: CLI_OPTIONS,
};
const TASK_LABELS = [
    { label: 'CONVERGED', matches: task => task.isConverged },
    { label: 'FAILED', matches: task => task.isFailed },
    { label: 'BLOCKED', matches: task => task.isBlocked },
    { label: 'PENDING', matches: task => task.isPending },
    { label: 'RUNNING', matches: task => task.isInProgress },
];
const STRING_OPTION_NAMES = [
    'repo',
    'state-root',
    'tasks',
    'agent',
    'model',
    'reasoning',
    'task',
    'unblock',
    'goal',
    'metric',
    'scope',
    'keep-converged',
    'parallel',
    'worktrees',
    'priority',
];
const BOOLEAN_OPTION_NAMES = [
    'loop',
    'status',
    'graph',
    'check',
    'stop',
    'once',
    'config',
    'keep-alive',
    'infinite',
    'auto-stash',
    'no-worktree',
    'help',
];
function readStringOption(value) {
    return typeof value === 'string' ? value : '';
}
function readBooleanOption(value) {
    return value === true;
}
function normalizeCliOptionValues(parsedValues) {
    const values = {};
    for (const name of STRING_OPTION_NAMES)
        values[name] = readStringOption(parsedValues[name]);
    for (const name of BOOLEAN_OPTION_NAMES)
        values[name] = readBooleanOption(parsedValues[name]);
    return values;
}
function parseCliArgsInternal() {
    const parsed = parseArgs(CLI_PARSE_CONFIG);
    return {
        positionals: [...parsed.positionals],
        values: normalizeCliOptionValues(parsed.values),
    };
}
async function promptMergeRecovery(failure) {
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
            const answer = (await rl.question('  How should orchestrator proceed? [1] manual cleanup/retry (default), [2] auto-stash worktree changes and retry merge: ')).trim().toLowerCase();
            if (answer === '' || answer === '1' || answer === 'm' || answer === 'manual') {
                return MergeRecoveryAction.Stop;
            }
            if (answer === '2' || answer === 's' || answer === 'stash' || answer === 'auto-stash') {
                return MergeRecoveryAction.StashAndRetry;
            }
            console.error('  Enter 1 for manual cleanup/retry, or 2 to auto-stash and retry merge.');
        }
    }
    finally {
        rl.close();
    }
}
function parseCliArgs() {
    try {
        return parseCliArgsInternal();
    }
    catch (e) {
        console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}`);
        console.error('  Run orchestrator --help for usage.\n');
        process.exit(1);
    }
}
function resolveCliPaths(values) {
    try {
        return resolveStatePaths({
            repo: values.repo || env.repoDir || undefined,
            stateRoot: values['state-root'] || env.stateRoot,
            tasks: values.tasks || env.tasksDir,
            worktrees: values.worktrees || env.worktreesDir,
        });
    }
    catch (e) {
        console.error(`\n  ❌ ${e instanceof Error ? e.message : String(e)}`);
        console.error('  Example: orchestrator --repo /path/to/your/repo\n');
        process.exit(1);
    }
}
function parseParallel(value, fallback) {
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
function parseOptionalInteger(flag, value) {
    if (!value)
        return undefined;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        console.warn(`⚠️  ${flag} must be a number; received '${value}', ignoring`);
        return undefined;
    }
    return parsed;
}
function normalizeRuntimeOptions(values, paths) {
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
function detectLineBreak(content) {
    return content.includes('\r\n') ? '\r\n' : '\n';
}
function splitSectionBody(body) {
    return body.split(/\r?\n/);
}
function findSectionRange(lines, heading) {
    const header = `## ${heading}`;
    const start = lines.findIndex(line => line === header || line.startsWith(`${header}:`));
    if (start === -1)
        return undefined;
    let end = start + 1;
    while (end < lines.length && !/^##\s/.test(lines[end]))
        end++;
    return [start, end];
}
function countTrailingBlankLines(lines, start, end) {
    let count = 0;
    for (let index = end - 1; index > start && lines[index] === ''; index--)
        count++;
    return count;
}
function replaceSection(content, heading, bodyLines) {
    const lineBreak = detectLineBreak(content);
    const lines = content.split(/\r?\n/);
    const range = findSectionRange(lines, heading);
    if (!range)
        return content;
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
function replaceAcceptanceMetric(content, metric) {
    const lineBreak = detectLineBreak(content);
    const lines = content.split(/\r?\n/);
    const range = findSectionRange(lines, 'Acceptance criteria');
    if (!range)
        return content;
    const [start, end] = range;
    const metricLineIndex = lines.findIndex((line, index) => index > start && index < end && line.includes('— task-specific deliverable'));
    if (metricLineIndex === -1)
        return content;
    const updatedLines = [...lines];
    updatedLines[metricLineIndex] = updatedLines[metricLineIndex]
        .replace(/`[^`]+`/, `\`${metric}\``)
        .replace(/METRIC\s+\w+=0/, `METRIC ${metric}=0`);
    return updatedLines.join(lineBreak);
}
function normalizeScope(scope) {
    return scope.split(/\s+/).filter(Boolean).map(file => `- ${file}`);
}
function updateAutoresearch(content, values) {
    let updated = content;
    if (values.goal) {
        updated = replaceSection(updated, 'Goal', splitSectionBody(values.goal));
    }
    if (values.metric) {
        updated = replaceAcceptanceMetric(updated, values.metric);
    }
    if (values.scope) {
        updated = replaceSection(updated, 'Scope', normalizeScope(values.scope));
    }
    return updated;
}
function taskLabel(task) {
    return TASK_LABELS.find(entry => entry.matches(task))?.label ?? 'UNKNOWN';
}
function parseTaskNumber(value, usage) {
    const taskNumber = parseInt(value ?? '', 10);
    if (Number.isNaN(taskNumber)) {
        console.error(usage);
        process.exit(1);
    }
    return taskNumber;
}
function pickTaskOrExit(engine, taskNumber) {
    const task = engine.pickByNumber(taskNumber);
    if (!task) {
        console.error(`T${taskNumber} not found`);
        process.exit(1);
    }
    return task;
}
function printPathsAndAgent(paths, agent) {
    console.log(`repo: ${paths.repo}`);
    console.log(`tasks: ${paths.tasks}`);
    console.log(`worktrees: ${paths.worktrees}`);
    console.log(`agent: ${agent.name}`);
}
function taskAutoresearchPath(task) {
    return join(task.directory, 'autoresearch.md');
}
function taskBenchmarkPath(task) {
    return resolve(task.directory, 'benchmark.js');
}
function taskBenchmarkLogPath(task) {
    return resolve(task.directory, 'benchmark.log');
}
function gitTopLevel(repo) {
    try {
        const topLevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
        return topLevel ? resolve(topLevel) : undefined;
    }
    catch {
        return undefined;
    }
}
function resolveAddRepo(values) {
    const repoInput = values.repo || env.repoDir || process.cwd();
    const repoPath = resolve(repoInput);
    if (!existsSync(repoPath)) {
        console.error(`\n  ❌ Repo path for add does not exist: ${repoPath}\n`);
        process.exit(1);
    }
    return gitTopLevel(repoPath) ?? repoPath;
}
function parsePriority(raw) {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
}
function buildAddTaskOptions(values, repoDir) {
    return {
        repoDir,
        ...(values.goal ? { goal: values.goal } : {}),
        ...(values.metric ? { metric: values.metric } : {}),
        ...(values.scope ? { scope: values.scope.split(/\s+/).filter(Boolean) } : {}),
        ...(values.priority ? { priority: parsePriority(values.priority) } : {}),
    };
}
function handleEditCommand(positionals, values, tasksDir, repo) {
    if (positionals[0] !== 'edit')
        return;
    if (!repo) {
        console.error('Usage: orchestrator edit <n> --repo <path> [--goal ...] [--metric ...] [--scope ...]');
        process.exit(1);
    }
    const taskNumber = parseTaskNumber(positionals[1], 'Usage: orchestrator edit <n> [--goal ...] [--metric ...] [--scope ...]');
    const engine = new Engine(tasksDir, { repoDir: repo });
    const task = pickTaskOrExit(engine, taskNumber);
    const autoresearchPath = taskAutoresearchPath(task);
    const updated = updateAutoresearch(readFileSync(autoresearchPath, 'utf-8'), values);
    writeFileSync(autoresearchPath, updated);
    if (values.priority) {
        engine.taskDb.setPriority(taskNumber, parsePriority(values.priority));
    }
    console.log(`✅ T${taskNumber} updated`);
    process.exit(0);
}
function handleAddCommand(positionals, values, tasksDir) {
    if (positionals[0] !== 'add')
        return;
    const name = positionals[1];
    if (!name) {
        console.error('Usage: orchestrator add <name> [--goal ...] [--metric ...] [--scope ...]');
        process.exit(1);
    }
    const repoDir = resolveAddRepo(values);
    const result = addTask(tasksDir, name, buildAddTaskOptions(values, repoDir));
    console.log(`✅ T${result.number} added: ${name}`);
    console.log(`   ${result.directory}`);
    console.log(`   repo: ${result.repo}`);
    console.log('   Next: edit autoresearch.md + benchmark.js, then npm run tick');
    process.exit(0);
}
function handleStatusCommand(enabled, tasksDir) {
    if (!enabled)
        return;
    const tdb = TaskDb.open(resolve(tasksDir, 'state.db'));
    try {
        const all = TaskState.scan(tdb, tasksDir);
        const nums = [...all.keys()].map(Number).sort((a, b) => a - b);
        console.log('');
        for (const key of nums) {
            const task = all.get(String(key));
            if (!task)
                continue;
            const deps = task.dependencies.length > 0 ? `  <- depends: ${task.dependencies.join(', ')}` : '';
            const goal = task.goal.length > 55 ? `${task.goal.slice(0, 52)}...` : task.goal;
            const repoTag = task.repo ? `  [${basename(task.repo)}]` : '';
            const prioTag = task.priority !== 0 ? `  prio:${task.priority}` : '';
            console.log(`  ${taskLabel(task).padEnd(9)} T${key}${repoTag}${prioTag}  ${goal}${deps}`);
            if (task.isBlocked) {
                console.log(`       blocked after ${task.failureCount} failures`);
            }
        }
        console.log(`  -- ${all.size} total\n`);
    }
    finally {
        tdb.close();
    }
    process.exit(0);
}
function handleGraphCommand(enabled, tasksDir) {
    if (!enabled)
        return;
    const tdb = TaskDb.open(resolve(tasksDir, 'state.db'));
    try {
        const nodes = [];
        for (const row of tdb.byStatus(['PENDING', 'IN_PROGRESS', 'FAILED', 'BLOCKED', 'CONVERGED'])) {
            const task = TaskState.fromRow(tdb, tasksDir, row);
            const status = row.status === 'IN_PROGRESS' ? 'running' : row.status.toLowerCase();
            nodes.push({ number: task.taskNumber, status, goal: task.goal, deps: [...task.dependencies] });
        }
        console.log('');
        for (const line of formatTaskGraph(nodes))
            console.log(line);
        console.log('');
    }
    finally {
        tdb.close();
    }
    process.exit(0);
}
function ensureRepoExists(repo) {
    if (existsSync(repo))
        return;
    console.error(`\n  ❌ Repo folder not found: ${repo}\n`);
    process.exit(1);
}
function ensureTasksDirExists(tasksDir) {
    if (existsSync(tasksDir))
        return;
    console.error(`\n  ❌ Tasks directory not found: ${tasksDir}`);
    console.error('  Create it with the add command, or pass --tasks / ORCH_TASKS to an existing task folder.\n');
    process.exit(1);
}
function printTickOutcome(result) {
    if (!result.task)
        return;
    const icon = result.converged ? '✅' : result.metric === 0 ? '⏳' : '❌';
    const status = result.converged ? 'converged' : result.metric === 0 ? 'convergence pending' : `metric=${result.metric}`;
    console.log(`  ${icon} T${result.task.number}: ${status} — ${result.task.goal.slice(0, 60)}`);
}
function handleUnblockCommand(engine, tasksDir, unblock) {
    if (!unblock)
        return;
    if (unblock.toLowerCase() === 'all') {
        const blocked = [...TaskState.scan(engine.taskDb, tasksDir).values()].filter(task => task.isBlocked);
        if (blocked.length === 0) {
            console.log('No blocked tasks to unblock.');
            process.exit(0);
        }
        for (const task of blocked)
            task.unblock();
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
function runBenchmarkScript(task, cwd) {
    return execFileSync(process.execPath, [taskBenchmarkPath(task)], {
        timeout: env.benchmarkTimeoutMs,
        encoding: 'utf-8',
        cwd,
    });
}
function handleTaskCommand(engine, taskValue, repo) {
    if (!taskValue)
        return;
    const taskNumber = parseTaskNumber(taskValue, 'Invalid task number');
    const task = pickTaskOrExit(engine, taskNumber);
    // Run the benchmark in the task's OWN repo (fall back to the CLI repo for
    // legacy/repo-less tasks) — this is what makes --task work in a mixed-repo queue.
    const taskRepo = task.repo ?? repo;
    if (!taskRepo) {
        console.error(`Invalid task command: T${taskNumber} has no repo; pass --repo (or set ORCH_REPO)`);
        process.exit(1);
    }
    try {
        const out = runBenchmarkScript(task, taskRepo);
        const metric = parseMetrics(out, 1, task.metricNames).total;
        console.log(`${metric === 0 ? '⏳' : '❌'} T${taskNumber} [${basename(taskRepo)}]: ${task.goal.slice(0, 60)} (metric=${metric})`);
    }
    catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.log(`❌ T${taskNumber}: benchmark failed (${reason})`);
    }
    process.exit(0);
}
function createAgent(values, runtime) {
    try {
        return createCodingAgent(values.agent || env.agent, {
            ...(values.reasoning ? { reasoning: values.reasoning } : {}),
            ...(values.model ? { model: values.model } : {}),
            ...(runtime.repo ? { workDir: runtime.repo } : {}),
        });
    }
    catch (e) {
        console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
    }
}
function handleConfigCommand(enabled, values, paths) {
    if (!enabled)
        return;
    console.log(formatEffectiveConfig({ ...values }, process.env));
    console.log('\nResolved paths');
    console.log(`  repo:       ${paths.repo}`);
    console.log(`  state root: ${paths.stateRoot}`);
    console.log(`  tasks:      ${paths.tasks}`);
    console.log(`  worktrees:  ${paths.worktrees}`);
    console.log('\n--check validates prerequisites and reports auth hints; runtime still validates agent auth.');
    process.exit(0);
}
async function handleCheckCommand(enabled, agent) {
    if (!enabled)
        return;
    const results = await Prerequisites.check(agent);
    console.log(Prerequisites.format(results));
    process.exit(results.every(result => result.ok) ? 0 : 1);
}
async function ensureAgentPrerequisites(agent) {
    const prereqs = await Prerequisites.check(agent);
    const failed = prereqs.filter(result => !result.ok);
    if (failed.length === 0)
        return;
    console.error(Prerequisites.format(prereqs));
    process.exit(1);
}
function createEngine(runtime, agent) {
    return new Engine(runtime.tasksDir, {
        ...(runtime.repo ? { repoDir: runtime.repo } : {}),
        worktreesDir: runtime.worktreesDir,
        noWorktree: runtime.noWorktree,
        autoStashBeforeMerge: runtime.autoStash,
        mergeRecovery: runtime.autoStash ? () => MergeRecoveryAction.StashAndRetry : promptMergeRecovery,
        parallel: runtime.parallel,
        ...(runtime.keepConverged !== undefined ? { keepConverged: runtime.keepConverged } : {}),
        infinite: runtime.infinite,
        spawn: (task, worktreePath, signal) => agent.spawn(task, worktreePath, signal),
        benchmark: async (task) => {
            const reasonPath = taskBenchmarkLogPath(task);
            let out;
            let crashed = false;
            try {
                out = runBenchmarkScript(task, task.cwd);
            }
            catch (e) {
                crashed = true;
                const err = e;
                out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || (err.message ?? 'benchmark execution failed');
            }
            try {
                writeFileSync(reasonPath, out);
            }
            catch (e) {
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
async function runOnce(engine) {
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
async function runLoop(engine, runtime) {
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
    }
    else if (runtime.infinite) {
        console.log(`\n🛑 stopped after ${tickCount} ticks\n`);
    }
    else {
        console.log(`\n🎉 ${tickCount} ticks — all done\n`);
    }
}
async function runEngine(engine, runtime, once) {
    try {
        if (once) {
            await runOnce(engine);
            return;
        }
        await runLoop(engine, runtime);
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`\n  ❌ ${message}\n`);
        process.exit(1);
    }
}
async function handlePreflightCommands(positionals, values, runtime, paths, agent) {
    handleConfigCommand(values.config, values, paths);
    handleEditCommand(positionals, values, runtime.tasksDir, runtime.repo);
    handleAddCommand(positionals, values, runtime.tasksDir);
    await handleCheckCommand(values.check, agent);
    handleStatusCommand(values.status, runtime.tasksDir);
    handleGraphCommand(values.graph, runtime.tasksDir);
}
function handleEngineCommands(engine, runtime, values) {
    handleUnblockCommand(engine, runtime.tasksDir, values.unblock);
    handleTaskCommand(engine, values.task, runtime.repo);
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
if (runtime.repo)
    ensureRepoExists(runtime.repo);
mkdirSync(paths.stateRoot, { recursive: true });
mkdirSync(runtime.worktreesDir, { recursive: true });
await handlePreflightCommands(positionals, values, runtime, paths, agent);
await ensureAgentPrerequisites(agent);
if (values.stop) {
    writeFileSync(resolve(runtime.tasksDir, '.stop'), '');
    console.log('Stop signal sent.');
    process.exit(0);
}
ensureTasksDirExists(runtime.tasksDir);
const engine = createEngine(runtime, agent);
handleEngineCommands(engine, runtime, values);
await runEngine(engine, runtime, values.once);
//# sourceMappingURL=cli.js.map