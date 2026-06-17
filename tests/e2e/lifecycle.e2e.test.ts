import { describe, it, afterEach, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTargetRepo, makePlainRepo, makeStateRoot,
  addTask, tick, loop, status, config, check, graph, stop, help,
  readTask, taskContentDir, tasksDirOf, writeBenchmark, makeExecAgent, seedLegacyShard,
  fileExistsOnBranch, cleanupAll, NOOP_AGENT,
  type RunOpts,
} from '../shared/e2e.js';

// A scripted benchmark that converges only once the agent's file has landed in
// the working tree (cwd = worktree during the post-agent check).
const LANDED_BENCH = [
  "import { existsSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const done = existsSync(join(process.cwd(), 'landed.txt'));",
  'console.log(`METRIC goal=${done ? 0 : 1}`);',
].join('\n');

// The scripted agent: drop a file in the worktree; the orchestrator auto-commits it.
const LANDS_FILE = [
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "writeFileSync(join(process.cwd(), 'landed.txt'), 'landed by exec agent\\n');",
].join('\n');

// Stateful benchmark: returns 0 on the first run, 1 forever after (a regression),
// appending each value to .calllog for assertions.
const REGRESSION_BENCH = [
  "import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  'const dir = import.meta.dirname;',
  "const cf = join(dir, '.calls');",
  "const n = existsSync(cf) ? Number(readFileSync(cf, 'utf8')) : 0;",
  'writeFileSync(cf, String(n + 1));',
  'const v = n === 0 ? 0 : 1;',
  "appendFileSync(join(dir, '.calllog'), v + '\\n');",
  'console.log(`METRIC goal=${v}`);',
].join('\n');

afterEach(() => cleanupAll());

describe('e2e: lifecycle', () => {
  it('add then --status lists the task (CANTOPEN guard on a fresh state root)', () => {
    const repo = makeTargetRepo();
    const stateRoot = makeStateRoot(); // never touched before — must not SQLITE_CANTOPEN
    const opts: RunOpts = { repo, stateRoot };

    const added = addTask('alpha', opts);
    expect(added.status).toBe(0);
    expect(added.stderr).not.toMatch(/CANTOPEN/i);
    expect(added.stdout).toContain('T1 added: alpha');

    // The flat T01-alpha content dir exists and the DB row is PENDING.
    const row = readTask(stateRoot, repo, 1);
    expect(row?.status).toBe('PENDING');
    expect(row?.dir).toBe('T01-alpha');
    expect(readFileSync(join(taskContentDir(stateRoot, repo, 1, 'alpha'), 'benchmark.js'), 'utf8')).toContain('METRIC');

    const s = status(opts);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain('PENDING');
    expect(s.stdout).toContain('T1');
  });

  it('converges a clean task and merges the agent commit onto the base branch', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('build', opts).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'build', LANDED_BENCH);

    const r = tick({ ...opts, env: { ...makeExecAgent(LANDS_FILE), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    // Task is terminal CONVERGED in the DB...
    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    // ...and the agent's file landed on the base branch via a real merge.
    expect(fileExistsOnBranch(repo, 'main', 'landed.txt')).toBe(true);
    expect(readFileSync(join(repo, 'landed.txt'), 'utf8')).toContain('landed by exec agent');
  });

  it('resets convergence on a metric regression and never merges prematurely', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // max-failures must be frozen at creation, so set it on `add`.
    expect(addTask('regress', { ...opts, env: { ORCH_MAX_FAILURES: '1' } }).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'regress', REGRESSION_BENCH);

    // CONVERGE=2 means the single zero run (cz=1) is not enough; the next run
    // regresses to 1, resetting convergence before any merge.
    const r = loop({
      ...opts,
      env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1', ORCH_CONVERGE: '2', ORCH_MAX_FAILURES: '1' },
    });
    expect(r.status).toBe(0);

    const row = readTask(stateRoot, repo, 1);
    expect(row?.status).toBe('BLOCKED'); // never CONVERGED
    expect(row?.convergence).toBe(0);    // convergence was reset

    const callLog = readFileSync(join(taskContentDir(stateRoot, repo, 1, 'regress'), '.calllog'), 'utf8')
      .trim().split('\n');
    expect(callLog[0]).toBe('0'); // first run hit metric 0 (cz incremented)
    expect(callLog).toContain('1'); // a later run regressed (cz reset)
  });

  it('imports a pre-existing file-shard task on the first run', () => {
    const repo = makePlainRepo();
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // OLD layout, written before any state.db exists.
    seedLegacyShard(stateRoot, repo, 1, 'old', {
      status: 'PENDING',
      autoresearch: '# T1 legacy\n## Goal\nlegacy shard task\n',
      benchmark: "console.log('METRIC done=1');",
    });

    const r = tick({ ...opts, env: { ...NOOP_AGENT, ORCH_NO_WORKTREE: '1' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('imported 1 task');

    // Imported into the DB at its shard-relative dir, and visible via --status.
    const row = readTask(stateRoot, repo, 1);
    expect(row?.name).toBe('old');
    expect(row?.dir).toBe(join('pending', 'T01-old'));
    expect(status(opts).stdout).toContain('T1');
  });

  describe('CLI surface', () => {
    it('--help prints usage and exits 0', () => {
      const opts: RunOpts = { repo: makePlainRepo(), stateRoot: makeStateRoot() };
      const r = help(opts);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('USAGE');
      expect(r.stdout).toContain('Task Orchestrator');
    });

    it('--config prints resolved settings and paths and exits 0', () => {
      const opts: RunOpts = { repo: makePlainRepo(), stateRoot: makeStateRoot() };
      const r = config(opts);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Resolved paths');
      expect(r.stdout).toContain('state root:');
    });

    it('--check reports prerequisites for the exec agent and exits 0', () => {
      const opts: RunOpts = { repo: makePlainRepo(), stateRoot: makeStateRoot() };
      const r = check({ ...opts, env: NOOP_AGENT });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('command');
    });

    it('--graph renders the dependency graph and exits 0', () => {
      const opts: RunOpts = { repo: makePlainRepo(), stateRoot: makeStateRoot() };
      expect(addTask('graphme', opts).status).toBe(0);
      const r = graph(opts);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Task dependency graph');
      expect(r.stdout).toContain('T1');
    });

    it('--status is read-only', () => {
      const repo = makePlainRepo();
      const stateRoot = makeStateRoot();
      const opts: RunOpts = { repo, stateRoot };
      expect(addTask('readonly', opts).status).toBe(0);

      const before = readTask(stateRoot, repo, 1);
      expect(status(opts).status).toBe(0);
      const after = readTask(stateRoot, repo, 1);

      expect(after?.status).toBe(before?.status);
      expect(after?.convergence).toBe(before?.convergence);
      expect(after?.updated_at).toBe(before?.updated_at);
    });

    it('--stop writes the stop signal file and exits 0', () => {
      const repo = makePlainRepo();
      const stateRoot = makeStateRoot();
      const opts: RunOpts = { repo, stateRoot };
      // Touch the DB first so the tasks dir exists for the stop file.
      expect(addTask('s', opts).status).toBe(0);

      const r = stop(opts);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Stop signal sent');
      expect(readFileSync(join(tasksDirOf(stateRoot, repo), '.stop'), 'utf8')).toBe('');
    });
  });
});
