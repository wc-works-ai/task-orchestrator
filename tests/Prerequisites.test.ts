import { describe, it, expect } from 'vitest';
import { Prerequisites } from '../src/Prerequisites.js';

describe('Prerequisites', () => {
  it('checks node version', async () => {
    const results = await Prerequisites.check();
    const node = results.find(r => r.name === 'node');
    expect(node).toBeDefined();
    expect(node!.ok).toBe(true);
  });

  it('detects missing optional tools gracefully', async () => {
    const results = await Prerequisites.check();
    // pi might not be installed — should still complete without throwing
    const pi = results.find(r => r.name === 'pi');
    if (pi && !pi.ok) {
      expect(pi.message).toContain('not found');
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
});
