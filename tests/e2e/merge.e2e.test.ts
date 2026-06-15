/**
 * E2E: the merge / base-sync core — the historically buggy heart of the engine.
 * Every scenario drives the REAL CLI against a REAL git repo; conflicts and base
 * advancement are produced deterministically by the scripted exec agent and
 * benchmark (both inherit ORCH_REPO, so they commit to the target's base branch
 * on cue) — no LLM, no flakiness.
 */
import { describe, it, afterEach, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTargetRepo, makeStateRoot, addTask, tick,
  readTask, writeBenchmark, makeExecAgent, fileExistsOnBranch, git, cleanupAll,
  type RunOpts,
} from '../shared/e2e.js';
import {
  agentScript, benchScript, markerBench, landAgentBody,
  worktreeDirOf, branchNameOf, branchExists, currentBranch, holdMergeLock,
} from './support.js';

const TIMEOUT = 60_000;

afterEach(() => cleanupAll());

describe('e2e: merge / base-sync', () => {
  it('clean merge: a converged agent change lands on the base branch', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('clean', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'clean', markerBench('landed.txt'));

    const r = tick({ ...opts, env: { ...makeExecAgent(landAgentBody('landed.txt')), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);
  }, TIMEOUT);

  it('base advanced (no conflict): syncs the new base commit, then merges both changes', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('advance', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'advance', markerBench('landed.txt'));

    // Agent lands its file AND advances the base on a DIFFERENT file → clean sync.
    const agent = agentScript("writeWt('landed.txt', 'agent\\n'); commitBase('other.txt', 'external\\n', 'advance base');");
    const r = tick({ ...opts, env: { ...makeExecAgent(agent), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);
    expect(fileExistsOnBranch(repo, 'main', 'other.txt')).toBe(true);
  }, TIMEOUT);

  it('base advanced (sync conflict): overlapping base edit blocks the task, branch kept', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('syncx', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'syncx', markerBench('marker.txt'));

    // Agent edits shared.txt in the worktree AND commits a divergent shared.txt to
    // the base — syncWithBase (base → branch) then conflicts before any merge.
    const agent = agentScript([
      "writeWt('marker.txt', 'x\\n');",
      "writeWt('shared.txt', 'agent-side\\n');",
      "commitBase('shared.txt', 'base-side\\n', 'conflicting base edit');",
    ].join('\n'));
    const r = tick({ ...opts, env: { ...makeExecAgent(agent), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('BLOCKED');
    expect(r.stdout).toContain('merge conflict');
    expect(r.stdout).toContain('BLOCKED');
    // Branch + worktree are kept for later manual merge; nothing reached the base.
    expect(branchExists(repo, branchNameOf(1, 'syncx'))).toBe(true);
    expect(existsSync(worktreeDirOf(stateRoot, repo, 1, 'syncx'))).toBe(true);
    expect(fileExistsOnBranch(repo, 'main', 'marker.txt')).toBe(false);
  }, TIMEOUT);

  it('merge-back conflict: a base edit landed after sync blocks at merge, branch kept', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // Common ancestor for shared.txt, so branch and base both DIVERGE from it.
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    git(repo, 'add', 'shared.txt');
    git(repo, 'commit', '-m', 'seed shared.txt');

    expect(addTask('mergex', opts).status).toBe(0);
    // The post-sync benchmark call (2nd worktree call) sneaks a conflicting base
    // commit in AFTER syncWithBase succeeds but BEFORE wt.merge() runs.
    writeBenchmark(stateRoot, repo, 1, 'mergex', benchScript([
      "if (exists('done.txt')) {",
      '  metric = 0;',
      "  if (wtCalls() === 2) commitBase('shared.txt', 'conflict-after-sync\\n', 'late base edit');",
      '}',
    ].join('\n')));

    const agent = agentScript("writeWt('shared.txt', 'agent\\n'); writeWt('done.txt', 'x\\n');");
    const r = tick({ ...opts, env: { ...makeExecAgent(agent), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('BLOCKED');
    expect(r.stdout).toContain('merge conflict');
    expect(branchExists(repo, branchNameOf(1, 'mergex'))).toBe(true);
    expect(existsSync(worktreeDirOf(stateRoot, repo, 1, 'mergex'))).toBe(true);
    expect(fileExistsOnBranch(repo, 'main', 'done.txt')).toBe(false);
  }, TIMEOUT);

  it('verifyCmd fails: rework instead of merge (work never reaches the base)', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('verifyx', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'verifyx', markerBench('landed.txt'));

    // Agent lands its file but breaks the worktree's `npm run tc` (the hardcoded
    // pre-merge verify gate) → engine sends the task back to rework, no merge.
    const agent = agentScript([
      "writeWt('landed.txt', 'agent\\n');",
      "const pkg = { name: 'e2e-target', version: '1.0.0', private: true, scripts: { tc: 'node -e \"process.exit(1)\"' } };",
      "writeWt('package.json', JSON.stringify(pkg, null, 2));",
    ].join('\n'));
    const r = tick({ ...opts, env: { ...makeExecAgent(agent), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(r.stdout).toContain('verify command failed; sending back to agent');
    const row = readTask(stateRoot, repo, 1);
    expect(row?.status).not.toBe('CONVERGED');
    expect(row?.convergence).toBe(0); // reset on rework
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(false);
  }, TIMEOUT);

  it('auto-stash: a dirty base working tree is stashed across the merge and restored', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('stash', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'stash', markerBench('landed.txt'));

    // Pre-dirty the base repo working tree (uncommitted user edit).
    writeFileSync(join(repo, 'README.md'), 'dirty by user\n');

    const r = tick({
      ...opts,
      env: { ...makeExecAgent(landAgentBody('landed.txt')), ORCH_CONVERGE: '1', ORCH_AUTO_STASH: '1' },
    });
    expect(r.status).toBe(0);

    expect(r.stdout).toContain('stashed parent repo changes before merge');
    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);
    // The user's uncommitted change is popped back afterwards (LF/CRLF agnostic).
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('dirty by user');
  }, TIMEOUT);

  it('branch restore: HEAD returns to the user branch after merging into the base', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // Task targets main (detected at add time); then the user moves HEAD to `work`.
    expect(addTask('restore', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'restore', markerBench('landed.txt'));
    git(repo, 'checkout', '-b', 'work');

    const r = tick({ ...opts, env: { ...makeExecAgent(landAgentBody('landed.txt')), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);
    expect(currentBranch(repo)).toBe('work'); // restored, not left on main
  }, TIMEOUT);

  it('merge lock held: defers this tick, merges on the next once the lock is released', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('lock', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'lock', markerBench('landed.txt'));

    // A fresh (non-stale) merge lock held by a "peer" orchestrator.
    const lockDir = holdMergeLock(repo);

    const env = { ...makeExecAgent(landAgentBody('landed.txt')), ORCH_CONVERGE: '1' };
    const t1 = tick({ ...opts, env });
    expect(t1.status).toBe(0);
    expect(t1.stdout).toContain('holds the merge lock');
    expect(readTask(stateRoot, repo, 1)?.status).toBe('IN_PROGRESS'); // parked, not merged
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(false);

    // Release the lock; next tick recovers the parked claim (HEARTBEAT_MS=1),
    // reconnects the worktree, and completes the merge.
    rmSync(lockDir, { recursive: true, force: true });
    const t2 = tick({ ...opts, env: { ...env, ORCH_HEARTBEAT_MS: '1' } });
    expect(t2.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);
  }, TIMEOUT);
});
