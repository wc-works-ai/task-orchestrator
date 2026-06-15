/**
 * E2E: dependency gating, block/cascade, unblock, and retry/failure accounting.
 * Most scenarios run in --no-worktree mode on a plain (non-git) repo for speed —
 * gating/cascade/retry don't need real worktrees. The unblock scenario uses a
 * real git repo to prove the branch + worktree survive an unblock and a re-run.
 */
import { describe, it, afterEach, expect } from 'vitest';
import { existsSync } from 'node:fs';
import {
  makeTargetRepo, makePlainRepo, makeStateRoot, addTask, tick, loop, runCli,
  readTask, writeBenchmark, makeExecAgent, NOOP_AGENT, fileExistsOnBranch, cleanupAll,
  type RunOpts,
} from '../shared/e2e.js';
import {
  benchScript, markerBench, landAgentBody,
  addDependency, holdInProgress, markConverged,
  worktreeDirOf, branchNameOf, branchExists,
} from './support.js';

const TIMEOUT = 60_000;
const ALWAYS_DONE = benchScript('metric = 0;');

afterEach(() => cleanupAll());

describe('e2e: block / unblock / retry', () => {
  it('dependency gating: a dependent task is not picked until its dependency converges', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('dep', opts).status).toBe(0);      // T1
    expect(addTask('child', opts).status).toBe(0);    // T2 depends on T1
    addDependency(stateRoot, repo, 2, 1);
    writeBenchmark(stateRoot, repo, 2, 'child', ALWAYS_DONE); // would converge instantly if picked

    // T1 is parked IN_PROGRESS by a "peer" (fresh heartbeat → not recovered), so
    // the ONLY status-pickable task is T2 — yet it is gated by the unmet dep.
    holdInProgress(stateRoot, repo, 1);
    const gated = tick({ ...opts, env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1' } });
    expect(gated.status).toBe(0);
    expect(gated.stdout).toContain('unmet deps [1]');
    expect(readTask(stateRoot, repo, 2)?.status).toBe('PENDING'); // never ran

    // Once the dependency converges, the child becomes pickable and converges.
    markConverged(stateRoot, repo, 1);
    const freed = tick({ ...opts, env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1', ORCH_CONVERGE: '1' } });
    expect(freed.status).toBe(0);
    expect(readTask(stateRoot, repo, 2)?.status).toBe('CONVERGED');
  }, TIMEOUT);

  it('blocked-dependency cascade: blocking a task auto-blocks its dependents', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('root', { ...opts, env: { ORCH_MAX_FAILURES: '1' } }).status).toBe(0); // T1
    expect(addTask('leaf', opts).status).toBe(0);                                          // T2 → T1
    addDependency(stateRoot, repo, 2, 1);
    writeBenchmark(stateRoot, repo, 1, 'root', markerBench('never.txt')); // metric stays 1 → fails out

    const r = loop({ ...opts, env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1', ORCH_MAX_FAILURES: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('BLOCKED'); // exhausted its single retry
    expect(readTask(stateRoot, repo, 2)?.status).toBe('BLOCKED'); // cascaded from T1
  }, TIMEOUT);

  it('--unblock: a blocked task returns to PENDING with branch + worktree preserved, then converges', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('flaky', { ...opts, env: { ORCH_MAX_FAILURES: '1' } }).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'flaky', markerBench('landed.txt'));

    // NOOP agent never lands the marker → one failure exhausts max-failures=1 →
    // BLOCKED, but the worktree + branch were created and are kept for inspection.
    const blocked = tick({ ...opts, env: { ...NOOP_AGENT, ORCH_MAX_FAILURES: '1' } });
    expect(blocked.status).toBe(0);
    expect(readTask(stateRoot, repo, 1)?.status).toBe('BLOCKED');
    expect(branchExists(repo, branchNameOf(1, 'flaky'))).toBe(true);
    expect(existsSync(worktreeDirOf(stateRoot, repo, 1, 'flaky'))).toBe(true);

    // --unblock resets it to PENDING (claim + failures cleared) but preserves the
    // branch and worktree.
    const unblocked = runCli(['--unblock', '1'], opts);
    expect(unblocked.status).toBe(0);
    expect(unblocked.stdout).toContain('T1 unblocked');
    const row = readTask(stateRoot, repo, 1);
    expect(row?.status).toBe('PENDING');
    expect(row?.failures).toBe(0);
    expect(branchExists(repo, branchNameOf(1, 'flaky'))).toBe(true);
    expect(existsSync(worktreeDirOf(stateRoot, repo, 1, 'flaky'))).toBe(true);

    // Retried with a real agent (reuses the preserved branch/worktree) → converges.
    const done = tick({ ...opts, env: { ...makeExecAgent(landAgentBody('landed.txt')), ORCH_CONVERGE: '1' } });
    expect(done.status).toBe(0);
    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);
  }, TIMEOUT);

  it('agent fails: the task goes FAILED and is retried (failure count climbs) the next tick', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // High max-failures so it never blocks across the two ticks we run.
    expect(addTask('retry', { ...opts, env: { ORCH_MAX_FAILURES: '9' } }).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'retry', markerBench('never.txt')); // always metric 1

    const env = { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1', ORCH_MAX_FAILURES: '9' };
    const t1 = tick({ ...opts, env });
    expect(t1.status).toBe(0);
    expect(readTask(stateRoot, repo, 1)?.status).toBe('FAILED');
    expect(readTask(stateRoot, repo, 1)?.failures).toBe(1);

    const t2 = tick({ ...opts, env }); // FAILED tasks are re-pickable
    expect(t2.status).toBe(0);
    expect(readTask(stateRoot, repo, 1)?.status).toBe('FAILED');
    expect(readTask(stateRoot, repo, 1)?.failures).toBe(2);
  }, TIMEOUT);

  it('max-failures: repeated failures eventually block the task', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('exhaust', { ...opts, env: { ORCH_MAX_FAILURES: '2' } }).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'exhaust', markerBench('never.txt'));

    const r = loop({ ...opts, env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1', ORCH_MAX_FAILURES: '2' } });
    expect(r.status).toBe(0);

    const row = readTask(stateRoot, repo, 1);
    expect(row?.status).toBe('BLOCKED');
    expect(row?.failures).toBe(2); // blocked exactly at the limit
  }, TIMEOUT);

  // Retry cooldown is configured to 0 in the CLI (no ORCH_* knob wires it up), so
  // it never skips a just-failed task at the process level. It is exercised at the
  // integration tier where the Engine is constructed with a non-zero cooldown.
  it.skip('retry cooldown: a just-failed task is skipped within the cooldown window (integration-tier)', () => {});
});
