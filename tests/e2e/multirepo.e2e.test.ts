import { describe, it, afterEach, expect } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTargetRepo, makeStateRoot, addTask, loop,
  readTask, writeBenchmark, makeExecAgent, fileExistsOnBranch, cleanupAll, tasksDirOf,
  type RunOpts,
} from '../shared/e2e.js';
import { agentScript, benchScript, currentBranch } from './support.js';
import { taskDirName } from '../../src/state/TaskDb.js';

const TIMEOUT = 90_000;
const MERGE_LOCK = '.orchestrator-merge-lock';

const PER_TASK_AGENT = agentScript(
  "import { basename } from 'node:path';\n" +
  "writeWt(basename(CWD) + '.txt', 'landed by exec agent\\n');",
);

const PER_TASK_BENCH = benchScript(
  "import { basename } from 'node:path';\n" +
  "metric = exists(basename(CWD) + '.txt') ? 0 : 1;",
);

const samePath = (a: string | null | undefined, b: string): boolean =>
  a !== null && a !== undefined && realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

afterEach(() => cleanupAll());

describe('e2e: multi-repo', () => {
  it('drains one global queue and merges each task into its own repo', () => {
    const repoA = makeTargetRepo('main');
    const repoB = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const optsA: RunOpts = { repo: repoA, stateRoot };
    const optsB: RunOpts = { repo: repoB, stateRoot };

    expect(tasksDirOf(stateRoot, repoA)).toBe(tasksDirOf(stateRoot, repoB));

    const addedA = addTask('repo-a', optsA, ['--repo', repoA]);
    expect(addedA.status).toBe(0);
    expect(addedA.stdout).toContain(repoA);
    const addedB = addTask('repo-b', optsB, ['--repo', repoB]);
    expect(addedB.status).toBe(0);
    expect(addedB.stdout).toContain(repoB);

    writeBenchmark(stateRoot, repoA, 1, 'repo-a', PER_TASK_BENCH);
    writeBenchmark(stateRoot, repoB, 2, 'repo-b', PER_TASK_BENCH);

    const r = loop({
      ...optsA,
      env: { ...makeExecAgent(PER_TASK_AGENT), ORCH_CONVERGE: '1', ORCH_PARALLEL: '2' },
    });
    expect(r.status).toBe(0);

    const markerA = `${taskDirName(1, 'repo-a')}.txt`;
    const markerB = `${taskDirName(2, 'repo-b')}.txt`;
    const taskA = readTask(stateRoot, repoA, 1);
    const taskB = readTask(stateRoot, repoB, 2);

    expect(taskA?.status).toBe('CONVERGED');
    expect(samePath(taskA?.repo, repoA)).toBe(true);
    expect(fileExistsOnBranch(repoA, 'main', markerA)).toBe(true);
    expect(fileExistsOnBranch(repoB, 'main', markerA)).toBe(false);

    expect(taskB?.status).toBe('CONVERGED');
    expect(samePath(taskB?.repo, repoB)).toBe(true);
    expect(fileExistsOnBranch(repoB, 'main', markerB)).toBe(true);
    expect(fileExistsOnBranch(repoA, 'main', markerB)).toBe(false);

    expect(existsSync(join(repoA, MERGE_LOCK))).toBe(false);
    expect(existsSync(join(repoB, MERGE_LOCK))).toBe(false);
    expect(currentBranch(repoA)).toBe('main');
    expect(currentBranch(repoB)).toBe('main');
  }, TIMEOUT);
});
