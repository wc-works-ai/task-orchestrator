import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appVersion } from '../../src/shared/version.js';

describe('appVersion', () => {
  it('reads the real package.json version via the default reader', () => {
    const expected = (JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version: string }).version;
    expect(appVersion()).toBe(expected);
  });

  it('returns the parsed version from an injected reader', () => {
    expect(appVersion(() => '{"version":"9.9.9"}')).toBe('9.9.9');
  });

  it('falls back to "unknown" when the version field is absent', () => {
    expect(appVersion(() => '{}')).toBe('unknown');
  });

  it('falls back to "unknown" when the reader throws', () => {
    expect(appVersion(() => { throw new Error('no file'); })).toBe('unknown');
  });
});
