import { describe, it, expect } from 'vitest';
import { Prerequisites } from '../../src/Prerequisites.js';

describe('Prerequisites', () => {
  it('checks node version', async () => {
    const results = await Prerequisites.check();
    const node = results.find(r => r.name === 'node');
    expect(node).toBeDefined();
    expect(node!.ok).toBe(true);
  });

  it('returns only node when no agent provided', async () => {
    const results = await Prerequisites.check();
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('node');
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
});
