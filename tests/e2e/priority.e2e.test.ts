import { describe, it, afterEach, expect } from 'vitest';
import {
  makeTargetRepo, makeStateRoot, addTask, tick,
  readTask, writeBenchmark, makeExecAgent, cleanupAll,
  type RunOpts,
} from '../shared/e2e.js';

// Converges once the agent's marker lands in the worktree (post-agent check).
const MARKER_BENCH = [
  "import { existsSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const done = existsSync(join(process.cwd(), 'landed.txt'));",
  'console.log(`METRIC goal=${done ? 0 : 1}`);',
].join('\n');

const LANDS_FILE = [
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "writeFileSync(join(process.cwd(), 'landed.txt'), 'landed\\n');",
].join('\n');

afterEach(() => cleanupAll());

describe('e2e: task priority ordering', () => {
  it('claims a higher-priority task before an earlier-created lower-priority one', () => {
    const repo = makeTargetRepo('main');
    const stateRoot = makeStateRoot();
    const opts: RunOpts = { repo, stateRoot };

    // T1 is created first but has the default priority 0; T2 is created later
    // with priority 10. Without priority, T1 (lowest number) would be claimed
    // first; with it, T2 must win.
    expect(addTask('low', opts).status).toBe(0);                        // T1, priority 0
    expect(addTask('high', opts, ['--priority', '10']).status).toBe(0); // T2, priority 10
    writeBenchmark(stateRoot, repo, 1, 'low', MARKER_BENCH);
    writeBenchmark(stateRoot, repo, 2, 'high', MARKER_BENCH);

    // A single tick claims+converges exactly one task (serial, CONVERGE=1).
    const r = tick({ ...opts, env: { ...makeExecAgent(LANDS_FILE), ORCH_CONVERGE: '1' } });
    expect(r.status).toBe(0);

    expect(readTask(stateRoot, repo, 2)?.status).toBe('CONVERGED'); // high ran first
    expect(readTask(stateRoot, repo, 1)?.status).toBe('PENDING');   // low still waiting
  });
});
