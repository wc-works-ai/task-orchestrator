import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCodingAgent } from '../../src/agents.js';
import { PiSpawner, type PiSpawnerOptions } from '../../src/PiSpawner.js';
import { memStateDb, seedState, type StateDb } from '../shared/helpers.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '1.0.0\n', stderr: '' })),
}));

function makeTask(s: StateDb, dir: string) {
  return seedState(s, dir, 1, 'agent', { autoresearch: '- **Model:** task-model\n## Goal\nTest' });
}

describe('createCodingAgent', () => {
  let dir = '';
  let s: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), '.test-agents-'));
    s = memStateDb();
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '1.0.0\n', stderr: '' } as ReturnType<typeof spawnSync>);
  });

  afterEach(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([undefined, '', 'pi'])('creates the pi agent for %s', (name) => {
    const opts: PiSpawnerOptions = { model: 'default-model', workDir: dir };
    const task = makeTask(s, dir);
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
