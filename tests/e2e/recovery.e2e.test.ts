/**
 * E2E: crash recovery, cross-process restart, startup reconciliation, and the
 * no-worktree path. Crashed workers and orphaned rows are reproduced by writing
 * directly to the state DB (a real worker crash is a SIGKILL we can't script
 * deterministically); the engine then has to put the world back together on its
 * next run.
 */
import { describe, it, afterEach, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTargetRepo, makePlainRepo, makeStateRoot, addTask, tick, runCli,
  readTask, writeBenchmark, taskContentDir, makeExecAgent, NOOP_AGENT, fileExistsOnBranch, cleanupAll,
  type RunOpts,
} from '../shared/e2e.js';
import { benchScript, markerBench, landAgentBody, agentScript, insertRawTask, simulateStaleClaim, worktreeDirOf } from './support.js';

const TIMEOUT = 60_000;
const ALWAYS_DONE = benchScript('metric = 0;');

afterEach(() => cleanupAll());

describe('e2e: recovery / reconciliation', () => {
  it('stale claim: a crashed worker is recovered to FAILED, re-picked, and convergence is preserved', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('crashed', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'crashed', ALWAYS_DONE);

    // Crashed mid-run: IN_PROGRESS with a stale heartbeat and convergence already
    // at 1. Threshold is 2, so the run can only finish in a single tick if the
    // seeded convergence SURVIVES recovery (recovery preserves it; block resets it).
    simulateStaleClaim(stateRoot, repo, 1, { convergence: 1 });

    const r = tick({ ...opts, env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1', ORCH_CONVERGE: '2', ORCH_HEARTBEAT_MS: '1' } });
    expect(r.status).toBe(0);

    const row = readTask(stateRoot, repo, 1);
    expect(row?.status).toBe('CONVERGED'); // recovered then converged this very tick
    expect(row?.failures).toBe(1);          // recovery counted one failure
    expect(row?.convergence).toBe(2);       // 1 (preserved) + 1 (this tick) = threshold
  }, TIMEOUT);

  it('restart mid-convergence: a fresh process reconnects the worktree and finishes the merge', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('resume', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'resume', markerBench('landed.txt'));

    const env = { ...makeExecAgent(landAgentBody('landed.txt')), ORCH_CONVERGE: '2' };
    // Tick 1: agent lands the file and converges ONCE (threshold 2) — not merged.
    const t1 = tick({ ...opts, env });
    expect(t1.status).toBe(0);
    const mid = readTask(stateRoot, repo, 1);
    expect(mid?.status).toBe('IN_PROGRESS');
    expect(mid?.convergence).toBe(1);
    expect(existsSync(worktreeDirOf(stateRoot, repo, 1, 'resume'))).toBe(true);
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(false); // not merged yet

    // Tick 2 (new process): recover the parked claim, reconnect the worktree from
    // the previous process, reach threshold, and merge.
    const t2 = tick({ ...opts, env: { ...env, ORCH_HEARTBEAT_MS: '1' } });
    expect(t2.status).toBe(0);
    expect(t2.stdout).toContain('reconnected');
    const done = readTask(stateRoot, repo, 1);
    expect(done?.status).toBe('CONVERGED');
    expect(done?.convergence).toBe(2);
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);

    // The sibling variant — worktree DIRECTORY deleted before restart, forcing a
    // recreate-from-branch (vs. reconnect) — is not deterministic at the process
    // level (self-heal recreates the worktree from the surviving branch on the
    // next tick); it is covered at the integration tier.
  }, TIMEOUT);

  it('startup reconciliation: incomplete CREATING dropped, completed CREATING promoted, missing dir blocked', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // T1: CREATING with no content dir → dropped.
    insertRawTask(stateRoot, repo, { taskNumber: 1, name: 'ghost', dir: 'T01-ghost', status: 'CREATING' });
    // T2: CREATING with content present → promoted, then converges this tick.
    insertRawTask(stateRoot, repo, { taskNumber: 2, name: 'ready', dir: 'T02-ready', status: 'CREATING' });
    const dir2 = taskContentDir(stateRoot, repo, 2, 'ready');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'benchmark.js'), ALWAYS_DONE);
    // T3: PENDING but its content dir vanished → blocked.
    insertRawTask(stateRoot, repo, { taskNumber: 3, name: 'gone', dir: 'T03-gone', status: 'PENDING' });

    const r = tick({ ...opts, env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1', ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dropped (incomplete create)');
    expect(r.stdout).toContain('promoted (content found)');
    expect(r.stdout).toContain('blocked (content dir missing)');

    expect(readTask(stateRoot, repo, 1)).toBeUndefined();       // dropped
    expect(readTask(stateRoot, repo, 2)?.status).toBe('CONVERGED'); // promoted then converged
    expect(readTask(stateRoot, repo, 3)?.status).toBe('BLOCKED');   // missing content dir
  }, TIMEOUT);

  it('no-worktree mode: the agent works directly in the repo and converges without any merge', () => {
    const repo = makePlainRepo(); // non-git → no worktree, no branch, no merge
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('direct', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'direct', markerBench('landed.txt'));

    // In no-worktree mode the engine measures the REPO itself (no worktree, no
    // branch, no merge), so the agent edits the repo directly.
    const landInRepo = agentScript("writeFileSync(join(REPO, 'landed.txt'), 'landed in repo\\n');");
    const r = runCli(['--once', '--no-worktree'], {
      ...opts,
      env: { ...makeExecAgent(landInRepo), ORCH_CONVERGE: '1' },
    });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(existsSync(join(repo, 'landed.txt'))).toBe(true); // landed in the repo itself
    expect(existsSync(join(repo, '.git'))).toBe(false);      // never a git operation/merge
  }, TIMEOUT);
});
