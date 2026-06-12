import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { TaskState, Status } from '../src/TaskState.js';

export function setupTestDir() {
  const dir = mkdtempSync(resolve(tmpdir(), 'orch-test-'));
  for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(dir, s), { recursive: true });
  }
  return dir;
}

export function makeTask(dir: string, n: number, name: string, opts?: {
  status?: Status | string;
  deps?: readonly number[];
  shard?: string;
}): TaskState {
  const shard = opts?.shard ?? 'pending';
  const d = resolve(dir, shard, `T${String(n).padStart(2, '0')}-${name}`);
  mkdirSync(d, { recursive: true });
  const t = new TaskState(d);
  t.status = opts?.status ?? Status.PENDING;
  if (opts?.deps) t.dependencies = opts.deps;
  return t;
}
