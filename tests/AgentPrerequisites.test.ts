import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { PiSpawner } from '../src/PiSpawner.js';
import { CopilotCliAgent } from '../src/CopilotCliAgent.js';
import { Prerequisites } from '../src/Prerequisites.js';
import type { CodingAgent, PrerequisiteResult } from '../src/CodingAgent.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

function spawnResult(status: number | null, stdout = '', stderr = ''): ReturnType<typeof spawnSync> {
  return { status, stdout, stderr } as ReturnType<typeof spawnSync>;
}

describe('PiSpawner.checkPrerequisites', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('returns pi and auth results', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '0.80.0\n'));
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test';
    try {
      const agent = new PiSpawner();
      const results = agent.checkPrerequisites();

      expect(results).toHaveLength(2);
      expect(results.map(r => r.name)).toEqual(['pi', 'auth']);
    } finally {
      if (prev) process.env.OPENROUTER_API_KEY = prev;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('reports pi binary found', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '0.80.0\n'));
    const agent = new PiSpawner();
    const results = agent.checkPrerequisites();
    const pi = results.find(r => r.name === 'pi')!;

    expect(pi.ok).toBe(true);
    expect(pi.message).toBe('0.80.0');
  });

  it('reports pi binary not found', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(1));
    const agent = new PiSpawner();
    const results = agent.checkPrerequisites();
    const pi = results.find(r => r.name === 'pi')!;

    expect(pi.ok).toBe(false);
    expect(pi.message).toBe('pi CLI not found — install with: npm install -g @earendil-works/pi-coding-agent');
  });

  it('reports pi version from stderr', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '', '0.79.0\n'));
    const agent = new PiSpawner();
    const results = agent.checkPrerequisites();
    const pi = results.find(r => r.name === 'pi')!;

    expect(pi.ok).toBe(true);
    expect(pi.message).toBe('0.79.0');
  });

  it('reports auth found via OPENROUTER_API_KEY', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '0.80.0\n'));
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    try {
      const agent = new PiSpawner();
      const results = agent.checkPrerequisites();
      const auth = results.find(r => r.name === 'auth')!;

      expect(auth.ok).toBe(true);
      expect(auth.message).toBe('API key found');
    } finally {
      if (prev) process.env.OPENROUTER_API_KEY = prev;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('reports auth found via ANTHROPIC_API_KEY', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '0.80.0\n'));
    const prevO = process.env.OPENROUTER_API_KEY;
    const prevA = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    try {
      const agent = new PiSpawner();
      const results = agent.checkPrerequisites();
      const auth = results.find(r => r.name === 'auth')!;

      expect(auth.ok).toBe(true);
      expect(auth.message).toBe('API key found');
    } finally {
      if (prevO) process.env.OPENROUTER_API_KEY = prevO;
      else delete process.env.OPENROUTER_API_KEY;
      if (prevA) process.env.ANTHROPIC_API_KEY = prevA;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('does not fail auth prerequisite when no API keys', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '0.80.0\n'));
    const prevO = process.env.OPENROUTER_API_KEY;
    const prevA = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const agent = new PiSpawner();
      const results = agent.checkPrerequisites();
      const auth = results.find(r => r.name === 'auth')!;

      expect(auth.ok).toBe(true);
      expect(auth.message).toBe('No API key env found; continuing (pi may use local/session auth)');
    } finally {
      if (prevO) process.env.OPENROUTER_API_KEY = prevO;
      if (prevA) process.env.ANTHROPIC_API_KEY = prevA;
    }
  });
});

describe('CopilotCliAgent.checkPrerequisites', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('returns copilot and auth results', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '1.0.0\n'));
    const prev = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = 'ghu_test';
    try {
      const agent = new CopilotCliAgent();
      const results = agent.checkPrerequisites();

      expect(results).toHaveLength(2);
      expect(results.map(r => r.name)).toEqual(['copilot', 'auth']);
    } finally {
      if (prev) process.env.COPILOT_GITHUB_TOKEN = prev;
      else delete process.env.COPILOT_GITHUB_TOKEN;
    }
  });

  it('reports copilot binary found', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '1.2.3\n'));
    const agent = new CopilotCliAgent();
    const results = agent.checkPrerequisites();
    const copilot = results.find(r => r.name === 'copilot')!;

    expect(copilot.ok).toBe(true);
    expect(copilot.message).toBe('1.2.3');
  });

  it('reports copilot binary not found', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(1));
    const agent = new CopilotCliAgent();
    const results = agent.checkPrerequisites();
    const copilot = results.find(r => r.name === 'copilot')!;

    expect(copilot.ok).toBe(false);
    expect(copilot.message).toBe('copilot CLI not found — install GitHub Copilot CLI');
  });

  it('reports copilot version from stderr', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '', '1.0.0-beta\n'));
    const agent = new CopilotCliAgent();
    const results = agent.checkPrerequisites();
    const copilot = results.find(r => r.name === 'copilot')!;

    expect(copilot.ok).toBe(true);
    expect(copilot.message).toBe('1.0.0-beta');
  });

  it('reports auth found via COPILOT_GITHUB_TOKEN', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '1.0.0\n'));
    const prev = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = 'ghu_test';
    try {
      const agent = new CopilotCliAgent();
      const results = agent.checkPrerequisites();
      const auth = results.find(r => r.name === 'auth')!;

      expect(auth.ok).toBe(true);
      expect(auth.message).toBe('GitHub token found');
    } finally {
      if (prev) process.env.COPILOT_GITHUB_TOKEN = prev;
      else delete process.env.COPILOT_GITHUB_TOKEN;
    }
  });

  it('reports auth found via GITHUB_TOKEN', () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '1.0.0\n'));
    const prevC = process.env.COPILOT_GITHUB_TOKEN;
    const prevG = process.env.GITHUB_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test';
    try {
      const agent = new CopilotCliAgent();
      const results = agent.checkPrerequisites();
      const auth = results.find(r => r.name === 'auth')!;

      expect(auth.ok).toBe(true);
      expect(auth.message).toBe('GitHub token found');
    } finally {
      if (prevC) process.env.COPILOT_GITHUB_TOKEN = prevC;
      else delete process.env.COPILOT_GITHUB_TOKEN;
      if (prevG) process.env.GITHUB_TOKEN = prevG;
      else delete process.env.GITHUB_TOKEN;
    }
  });

  it('reports auth found via gh auth status', () => {
    const prevC = process.env.COPILOT_GITHUB_TOKEN;
    const prevG = process.env.GITHUB_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    vi.mocked(spawnSync).mockImplementation(((cmd: string | URL) => {
      if (String(cmd) === 'copilot') return spawnResult(0, '1.0.0\n');
      if (String(cmd) === 'gh') return spawnResult(0);
      return spawnResult(1);
    }) as typeof spawnSync);
    try {
      const agent = new CopilotCliAgent();
      const results = agent.checkPrerequisites();
      const auth = results.find(r => r.name === 'auth')!;

      expect(auth.ok).toBe(true);
      expect(auth.message).toBe('GitHub authenticated (gh)');
    } finally {
      if (prevC) process.env.COPILOT_GITHUB_TOKEN = prevC;
      if (prevG) process.env.GITHUB_TOKEN = prevG;
    }
  });

  it('reports auth missing when no tokens and gh not authed', () => {
    const prevC = process.env.COPILOT_GITHUB_TOKEN;
    const prevG = process.env.GITHUB_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    vi.mocked(spawnSync).mockImplementation(((cmd: string | URL) => {
      if (String(cmd) === 'copilot') return spawnResult(0, '1.0.0\n');
      if (String(cmd) === 'gh') return spawnResult(1);
      return spawnResult(1);
    }) as typeof spawnSync);
    try {
      const agent = new CopilotCliAgent();
      const results = agent.checkPrerequisites();
      const auth = results.find(r => r.name === 'auth')!;

      expect(auth.ok).toBe(false);
      expect(auth.message).toBe('authenticate with: gh auth login (or set COPILOT_GITHUB_TOKEN)');
    } finally {
      if (prevC) process.env.COPILOT_GITHUB_TOKEN = prevC;
      if (prevG) process.env.GITHUB_TOKEN = prevG;
    }
  });
});

describe('Prerequisites.check with agent', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('includes agent prerequisites when agent is provided', async () => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '0.80.0\n'));
    const prevO = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test';
    try {
      const agent = new PiSpawner();
      const results = await Prerequisites.check(agent);

      expect(results.map(r => r.name)).toEqual(['node', 'pi', 'auth']);
    } finally {
      if (prevO) process.env.OPENROUTER_API_KEY = prevO;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe('CodingAgent interface generalization proof', () => {
  class FakeAgent implements CodingAgent {
    readonly name = 'fake';
    checkPrerequisites(): PrerequisiteResult[] {
      return [{ name: 'fake', ok: true, message: 'ok' }];
    }
    async spawn() {
      return { success: true, iterations: 1 };
    }
  }

  it('fake agent compiles against the interface', () => {
    const agent: CodingAgent = new FakeAgent();
    expect(agent.name).toBe('fake');
    expect(typeof agent.checkPrerequisites).toBe('function');
    expect(typeof agent.spawn).toBe('function');
  });

  it('Prerequisites.check includes both node and fake agent entries', async () => {
    const fake = new FakeAgent();
    const results = await Prerequisites.check(fake);

    expect(results.map(r => r.name)).toContain('node');
    expect(results.map(r => r.name)).toContain('fake');
  });
});
