import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { TaskState, Status } from '../src/TaskState.js';
import { PiSpawner } from '../src/PiSpawner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const { spawn } = await vi.importMock<typeof import('node:child_process')>('node:child_process');

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function setup() {
  const dir = mkdtempSync(resolve('/tmp', 'pi-spawn-'));
  for (const s of ['pending', 'in_progress']) mkdirSync(resolve(dir, s), { recursive: true });
  return dir;
}

function make(dir: string, n: number, name: string, goal?: string): TaskState {
  const d = resolve(dir, 'pending', `T${String(n).padStart(2, '0')}-${name}`);
  mkdirSync(d, { recursive: true });
  const t = new TaskState(d);
  t.status = Status.PENDING;
  if (goal) writeFileSync(resolve(d, 'autoresearch.md'), goal);
  return t;
}

describe('PiSpawner', () => {
  let dir = '';
  beforeEach(() => { dir = setup(); vi.clearAllMocks(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('uses model from task metadata', () => {
    const t = make(dir, 1, 'a', '- **Model:** custom-model\n## Goal\nTest');
    expect(new PiSpawner().modelFor(t)).toBe('custom-model');
  });

  it('falls back to constructor default', () => {
    const t = make(dir, 1, 'a');
    expect(new PiSpawner({ model: 'fallback' }).modelFor(t)).toBe('fallback');
  });

  it('falls back to ORCH_MODEL env var', () => {
    process.env.ORCH_MODEL = 'env-model';
    const t = make(dir, 1, 'a');
    expect(new PiSpawner().modelFor(t)).toBe('env-model');
    delete process.env.ORCH_MODEL;
  });

  it('hardcoded default is owl-alpha', () => {
    expect(new PiSpawner().modelFor(make(dir, 1, 'a'))).toBe('openrouter/owl-alpha');
  });

  it('spawn calls pi with correct model', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = new MockChild();
    vi.mocked(spawn).mockReturnValue(mock as any);

    const p = new PiSpawner().spawn(t);
    setTimeout(() => mock.emit('close', 0), 5);
    const r = await p;
    expect(r.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith('pi', expect.arrayContaining(['--model', 'test-model']), expect.any(Object));
  });

  it('returns failure on non-zero exit', async () => {
    const mock = new MockChild();
    vi.mocked(spawn).mockReturnValue(mock as any);
    const p = new PiSpawner().spawn(make(dir, 1, 'a'));
    setTimeout(() => mock.emit('close', 1), 5);
    expect((await p).success).toBe(false);
  });
});
