import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('cli benchmark execution', () => {
  it('uses execFileSync with process.execPath and resolve for benchmark execution', () => {
    const source = readFileSync(resolve(process.cwd(), 'src', 'cli.ts'), 'utf-8');

    expect(source).toContain("import { execFileSync } from 'node:child_process'");
    expect(source).toContain("execFileSync(process.execPath, [resolve(t.directory, 'benchmark.js')]");
    expect(source).toContain("execFileSync(process.execPath, [resolve(task.directory, 'benchmark.js')]");
    expect(source).not.toContain('execSync(`node ${t.directory}/benchmark.js`');
    expect(source).not.toContain('execSync(`node ${task.directory}/benchmark.js`');
  });

  it('sets verifyCmd default to "npm run tc" for coverage enforcement', () => {
    const source = readFileSync(resolve(process.cwd(), 'src', 'cli.ts'), 'utf-8');

    expect(source).toContain('verifyCmd: \'npm run tc\'');
    expect(source).toContain('new Engine(dir, {');
  });
});

