import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCodingAgent } from '../src/agents.js';
import { PiSpawner, type PiSpawnerOptions } from '../src/PiSpawner.js';
import { TaskState } from '../src/TaskState.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '1.0.0\n', stderr: '' })),
}));

function makeTask(dir: string): TaskState {
  const taskDir = resolve(dir, 'pending', 'T01-agent');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(resolve(taskDir, 'autoresearch.md'), '- **Model:** task-model\n## Goal\nTest');
  return new TaskState(taskDir);
}

describe('createCodingAgent', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(resolve(process.cwd(), '.test-agents-'));
    mkdirSync(resolve(dir, 'pending'), { recursive: true });
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '1.0.0\n', stderr: '' } as ReturnType<typeof spawnSync>);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([undefined, '', 'pi'])('creates the pi agent for %s', (name) => {
    const opts: PiSpawnerOptions = { model: 'default-model', workDir: dir };
    const task = makeTask(dir);
    const agent = createCodingAgent(name, opts);

    expect(agent.name).toBe('pi');
    expect((agent as PiSpawner).resolveModel(task)).toBe(new PiSpawner(opts).modelFor(task));
  });

  it('rejects unsupported agents with supported names', () => {
    expect(() => createCodingAgent('nope', {})).toThrow(/Supported agents: pi, copilot/);
  });

  it('creates the copilot agent', () => {
    const agent = createCodingAgent('copilot', { workDir: dir });

    expect(agent.name).toBe('copilot');
  });

  it('created agent exposes checkPrerequisites', () => {
    const agent = createCodingAgent('pi', { workDir: dir });
    const prereqs = agent.checkPrerequisites();

    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBeGreaterThan(0);
    for (const r of prereqs) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.ok).toBe('boolean');
      expect(typeof r.message).toBe('string');
    }
  });
});
