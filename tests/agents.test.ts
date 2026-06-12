import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCodingAgent } from '../src/agents.js';
import { PiSpawner, type PiSpawnerOptions } from '../src/PiSpawner.js';
import { TaskState } from '../src/TaskState.js';

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
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([undefined, '', 'pi'])('creates the pi agent for %s', (name) => {
    const opts: PiSpawnerOptions = { model: 'default-model', workDir: dir };
    const task = makeTask(dir);
    const agent = createCodingAgent(name, opts);

    expect(agent.name).toBe('pi');
    expect(agent.resolveModel(task)).toBe(new PiSpawner(opts).modelFor(task));
  });

  it('rejects unsupported agents with supported names', () => {
    expect(() => createCodingAgent('nope', {})).toThrow(/Supported agents: pi/);
  });
});
