/**
 * E2E: concurrent task execution — proves the orchestrator runs multiple tasks
 * at once with no cross-contamination, no double-processing, no lost or corrupt
 * merges, and no leaked locks. Two flavours of concurrency are covered:
 *  - in-process `--parallel` (one CLI running N ticks at once), and
 *  - multiple worker PROCESSES sharing one state DB + repo.
 * Every task drops a file named after its own worktree (`T0n-name.txt`), so
 * parallel tasks touch DISTINCT paths and every merge to the base is
 * conflict-free — the determinism comes from the scripted exec agent + benchmark.
 */
import { describe, it, afterEach, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTargetRepo, makeStateRoot, addTask, loop, loopAsync,
  readTask, writeBenchmark, makeExecAgent, fileExistsOnBranch, cleanupAll,
  type RunOpts,
} from '../shared/e2e.js';
import { agentScript, benchScript, currentBranch } from './support.js';
import { taskDirName } from '../../src/state/TaskDb.js';

const TIMEOUT = 60_000;
const MERGE_LOCK = '.orchestrator-merge-lock';

// Agent: drop a marker named after this task's worktree dir, so concurrent tasks
// never write the same path (and merges to the base never collide).
const PER_TASK_AGENT = agentScript(
  "import { basename } from 'node:path';\n" +
  "writeWt(basename(CWD) + '.txt', 'landed by exec agent\\n');",
);
// Benchmark: done (0) once this task's own marker exists in the cwd.
const PER_TASK_BENCH = benchScript(
  "import { basename } from 'node:path';\n" +
  "metric = exists(basename(CWD) + '.txt') ? 0 : 1;",
);
// A benchmark that always crashes (missing import) — a structural defect the
// agent cannot fix; the orchestrator must BLOCK only this task.
const CRASH_BENCH = "import './does-not-exist.mjs';\nconsole.log('METRIC goal=0');";

function seedTasks(opts: RunOpts, stateRoot: string, repo: string, names: readonly string[]): void {
  names.forEach((name, i) => {
    expect(addTask(name, opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, i + 1, name, PER_TASK_BENCH);
  });
}

/** Assert task `n` converged and its marker landed on the base branch. */
function expectConvergedAndMerged(stateRoot: string, repo: string, n: number, name: string): void {
  expect(readTask(stateRoot, repo, n)?.status).toBe('CONVERGED');
  expect(fileExistsOnBranch(repo, 'main', `${taskDirName(n, name)}.txt`)).toBe(true);
}

afterEach(() => cleanupAll());

describe('e2e: concurrency', () => {
  it('--parallel runs independent tasks at once and merges them all onto the base', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };
    const names = ['alpha', 'beta', 'gamma'];
    seedTasks(opts, stateRoot, repo, names);

    const r = loop({ ...opts, env: { ...makeExecAgent(PER_TASK_AGENT), ORCH_CONVERGE: '1', ORCH_PARALLEL: '3' } });
    expect(r.status).toBe(0);

    // Every task converged and its (distinct) file landed via a real merge —
    // the merge lock serialized the three concurrent merges without loss.
    names.forEach((name, i) => expectConvergedAndMerged(stateRoot, repo, i + 1, name));
    // No leaked merge lock; repo restored to its base branch.
    expect(existsSync(join(repo, MERGE_LOCK))).toBe(false);
    expect(currentBranch(repo)).toBe('main');
  }, TIMEOUT);

  it('parallel=0 (unlimited) converges every ready task', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };
    const names = ['u1', 'u2', 'u3'];
    seedTasks(opts, stateRoot, repo, names);

    const r = loop({ ...opts, env: { ...makeExecAgent(PER_TASK_AGENT), ORCH_CONVERGE: '1', ORCH_PARALLEL: '0' } });
    expect(r.status).toBe(0);

    names.forEach((name, i) => expectConvergedAndMerged(stateRoot, repo, i + 1, name));
    expect(existsSync(join(repo, MERGE_LOCK))).toBe(false);
  }, TIMEOUT);

  it('two concurrent worker processes share state and process every task exactly once', async () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };
    const names = ['one', 'two', 'three'];
    seedTasks(opts, stateRoot, repo, names);

    // Two independent CLI processes loop over the SAME state DB + repo at once.
    // DB claim tokens prevent double-pickup; the merge lock serializes merges.
    const env = { ...makeExecAgent(PER_TASK_AGENT), ORCH_CONVERGE: '1' };
    const [a, b] = await Promise.all([
      loopAsync({ ...opts, env }),
      loopAsync({ ...opts, env }),
    ]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);

    // Whichever worker did each task, every one converged and landed exactly once.
    names.forEach((name, i) => expectConvergedAndMerged(stateRoot, repo, i + 1, name));
    expect(existsSync(join(repo, MERGE_LOCK))).toBe(false);
    expect(currentBranch(repo)).toBe('main');
  }, 90_000);

  it('a broken benchmark blocks only its own task while concurrent siblings converge', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };
    ['healthy1', 'broken', 'healthy2'].forEach(name => expect(addTask(name, opts).status).toBe(0));
    writeBenchmark(stateRoot, repo, 1, 'healthy1', PER_TASK_BENCH);
    writeBenchmark(stateRoot, repo, 2, 'broken', CRASH_BENCH);
    writeBenchmark(stateRoot, repo, 3, 'healthy2', PER_TASK_BENCH);

    const r = loop({ ...opts, env: { ...makeExecAgent(PER_TASK_AGENT), ORCH_CONVERGE: '1', ORCH_PARALLEL: '3' } });
    expect(r.status).toBe(0); // the broken task does not hang or fail the whole fleet

    // The broken task is BLOCKED with no retry consumed (a benchmark defect).
    const broken = readTask(stateRoot, repo, 2);
    expect(broken?.status).toBe('BLOCKED');
    expect(broken?.failures).toBe(0);

    // Its concurrent siblings converged and merged independently.
    expectConvergedAndMerged(stateRoot, repo, 1, 'healthy1');
    expectConvergedAndMerged(stateRoot, repo, 3, 'healthy2');
    expect(existsSync(join(repo, MERGE_LOCK))).toBe(false);
  }, TIMEOUT);
});
