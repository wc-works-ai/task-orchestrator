import { describe, it, afterEach, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTargetRepo, makeStateRoot, addTask, tick, loop,
  readTask, writeBenchmark, makeExecAgent, fileExistsOnBranch, cleanupAll,
  type RunOpts,
} from '../shared/e2e.js';

// Mirrors the review-task fix: review_gap=0 only when a *substantive* review
// (>= 300 chars) exists at reviews/config.md in the cwd (the worktree on the
// post-agent check). The length gate is what stops a trivial/empty artifact
// from being a false-positive convergence.
const REVIEW_BENCH = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  "const p = resolve(process.cwd(), 'reviews/config.md');",
  'let gap = 1;',
  "try { const txt = existsSync(p) ? readFileSync(p, 'utf-8') : ''; gap = txt.trim().length >= 300 ? 0 : 1; } catch { gap = 1; }",
  'console.log(`METRIC review_gap=${gap}`);',
].join('\n');

// Scripted exec agent: write a review of `chars` length into the worktree; the
// orchestrator auto-commits it before the benchmark runs.
const writeReviewAgent = (chars: number): string => [
  "import { writeFileSync, mkdirSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "mkdirSync(join(process.cwd(), 'reviews'), { recursive: true });",
  `writeFileSync(join(process.cwd(), 'reviews', 'config.md'), 'R'.repeat(${chars}) + '\\n');`,
].join('\n');

afterEach(() => cleanupAll());

describe('e2e: review-task benchmark (artifact-substance gate)', () => {
  it('converges and merges once a substantive review file lands on the base branch', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    expect(addTask('review-config', opts, ['--metric', 'review_gap']).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'review-config', REVIEW_BENCH);

    // Agent writes a 400-char review; CONVERGE=1 means one zero run merges it.
    const r = tick({ ...opts, env: { ...makeExecAgent(writeReviewAgent(400)), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('CONVERGED');
    expect(fileExistsOnBranch(repo, 'main', 'reviews/config.md')).toBe(true);
    expect(readFileSync(join(repo, 'reviews', 'config.md'), 'utf8').trim().length).toBeGreaterThanOrEqual(300);
  });

  it('blocks instead of converging when the review is too short (substance gate)', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // max-failures is frozen at creation, so set it on `add`.
    expect(addTask('review-config', { ...opts, env: { ORCH_MAX_FAILURES: '1' } }, ['--metric', 'review_gap']).status).toBe(0);
    writeBenchmark(stateRoot, repo, 1, 'review-config', REVIEW_BENCH);

    // A 20-char review never satisfies the >=300 gate, so the task fails its one
    // allowed attempt and blocks — it must NOT converge or merge.
    const r = loop({ ...opts, env: { ...makeExecAgent(writeReviewAgent(20)), ORCH_CONVERGE: '1', ORCH_MAX_FAILURES: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 1)?.status).toBe('BLOCKED');
    expect(fileExistsOnBranch(repo, 'main', 'reviews/config.md')).toBe(false);
  });
});
