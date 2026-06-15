import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ExecAgent } from '../../src/ExecAgent.js';
import { memStateDb, seedState, type StateDb } from '../shared/helpers.js';

let s: StateDb;

function make(dir: string) {
  return seedState(s, dir, 1, 'exec', { autoresearch: '## Goal\nIntegration' });
}

describe('ExecAgent (integration)', () => {
  let dir = '';
  let worktree = '';
  const original = process.env.ORCH_AGENT_CMD;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), '.exec-int-'));
    worktree = join(dir, 'worktree');
    mkdirSync(worktree, { recursive: true });
    s = memStateDb();
  });

  afterEach(async () => {
    s.db.close();
    if (original === undefined) delete process.env.ORCH_AGENT_CMD;
    else process.env.ORCH_AGENT_CMD = original;
    await rm(dir, { recursive: true, force: true });
  });

  it('succeeds when the configured command exits 0', async () => {
    writeFileSync(join(worktree, 'ok.js'), 'process.exit(0);');
    process.env.ORCH_AGENT_CMD = 'node ok.js';

    const result = await new ExecAgent().spawn(make(dir), worktree);

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('fails when the configured command exits non-zero', async () => {
    writeFileSync(join(worktree, 'bad.js'), 'process.exit(1);');
    process.env.ORCH_AGENT_CMD = 'node bad.js';

    const result = await new ExecAgent().spawn(make(dir), worktree);

    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 1');
  });

  it('runs in the worktree and exposes orchestrator env vars to the command', async () => {
    writeFileSync(
      join(worktree, 'write.js'),
      "const fs = require('fs');\n" +
        "fs.writeFileSync('out.txt', [process.env.ORCH_TASK_NUMBER, process.env.ORCH_GOAL, process.env.ORCH_WORKTREE].join('|'));\n",
    );
    process.env.ORCH_AGENT_CMD = 'node write.js';

    const result = await new ExecAgent().spawn(make(dir), worktree);

    expect(result.success).toBe(true);
    const outPath = join(worktree, 'out.txt');
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf-8')).toBe(`1|Integration|${worktree}`);
  });
});
