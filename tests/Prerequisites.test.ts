import { describe, it, expect } from 'vitest';
import { Prerequisites } from '../src/Prerequisites.js';

describe('Prerequisites', () => {
  it('checks node version', async () => {
    const results = await Prerequisites.check();
    const node = results.find(r => r.name === 'node');
    expect(node).toBeDefined();
    expect(node!.ok).toBe(true);
  });

  it('env var checks do not throw when missing', async () => {
    const results = await Prerequisites.check();
    for (const r of results) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.ok).toBe('boolean');
      expect(typeof r.message).toBe('string');
    }
  });

  // ── format ─────────────────────────────────────────────────────────

  it('format shows all-pass', () => {
    const out = Prerequisites.format([
      { name: 'node', ok: true, message: 'Node v22' },
      { name: 'git',  ok: true, message: 'installed' },
    ]);
    expect(out).toContain('✅ node: Node v22');
    expect(out).toContain('✅ git: installed');
    expect(out).not.toContain('issue(s) found');
  });

  it('format shows failures with count', () => {
    const out = Prerequisites.format([
      { name: 'node', ok: false, message: 'Node v18 (need >=22)' },
      { name: 'pi',   ok: false, message: 'not found' },
    ]);
    expect(out).toContain('❌ node: Node v18 (need >=22)');
    expect(out).toContain('❌ pi: not found');
    expect(out).toContain('2 issue(s) found. Fix before running.');
  });

  it('format shows mixed results', () => {
    const out = Prerequisites.format([
      { name: 'node', ok: true,  message: 'Node v22' },
      { name: 'pi',   ok: false, message: 'not found' },
    ]);
    expect(out).toContain('✅ node: Node v22');
    expect(out).toContain('❌ pi: not found');
    expect(out).toContain('1 issue(s) found. Fix before running.');
  });

  it('API key check fails when no env var set', async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    const prevA = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const results = await Prerequisites.check();
      const api = results.find(r => r.name === 'API key')!;
      expect(api.ok).toBe(false);
      expect(api.message).toContain('set');
    } finally {
      if (prev) process.env.OPENROUTER_API_KEY = prev;
      if (prevA) process.env.ANTHROPIC_API_KEY = prevA;
    }
  });

  it('API key check passes when env var set', async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test';
    try {
      const results = await Prerequisites.check();
      const api = results.find(r => r.name === 'API key')!;
      expect(api.ok).toBe(true);
    } finally {
      if (prev) process.env.OPENROUTER_API_KEY = prev;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('node check passes when version >= 22', async () => {
    const results = await Prerequisites.check();
    const node = results.find(r => r.name === 'node')!;
    expect(node.ok).toBe(true);
  });

  it('node check fails when version < 22', async () => {
    const prev = process.version;
    Object.defineProperty(process, 'version', { value: 'v20.0.0', configurable: true });
    try {
      const results = await Prerequisites.check();
      const node = results.find(r => r.name === 'node')!;
      expect(node.ok).toBe(false);
    } finally {
      Object.defineProperty(process, 'version', { value: prev, configurable: true });
    }
  });

  it('checkApiKey false branch hits key.length > 0 when both env vars absent', async () => {
    // Force both env vars to be absent to cover the false branch of key.length > 0
    const prevO = process.env.OPENROUTER_API_KEY;
    const prevA = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const results = await Prerequisites.check();
      const api = results.find(r => r.name === 'API key')!;
      expect(api.ok).toBe(false);
      expect(api.message).toBe('set OPENROUTER_API_KEY or ANTHROPIC_API_KEY');
    } finally {
      if (prevO) process.env.OPENROUTER_API_KEY = prevO;
      else delete process.env.OPENROUTER_API_KEY;
      if (prevA) process.env.ANTHROPIC_API_KEY = prevA;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('checkApiKey covers true branch with key set', async () => {
    const prevO = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-api-key-12345';
    try {
      const results = await Prerequisites.check();
      const api = results.find(r => r.name === 'API key')!;
      expect(api.ok).toBe(true);
      expect(api.message).toBe('found');
    } finally {
      if (prevO) process.env.OPENROUTER_API_KEY = prevO;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });
});
