import { spawnSync } from 'node:child_process';

export interface PrerequisiteResult {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export class Prerequisites {
  static async check(): Promise<PrerequisiteResult[]> {
    const nodeResult = Prerequisites.checkNode();
    const piResult = Prerequisites.checkPi();
    const apiResult = Prerequisites.checkApiKey();
    return [nodeResult, piResult, apiResult];
  }

  private static checkNode(): PrerequisiteResult {
    const v = process.version;
    /* v8 ignore next: ?? fallback for undefined array index */
    const major = parseInt(v.slice(1).split('.')[0] ?? '0', 10);
    return { name: 'node', ok: major >= 22, message: `Node ${v} (need >=22)` };
  }

  private static checkPi(): PrerequisiteResult {
    const r = spawnSync('pi', ['--version'], { timeout: 5000, encoding: 'utf-8' });
    return {
      name: 'pi',
      ok: r.status === 0,
      message: r.status === 0 ? (r.stdout?.trim() || 'installed') : 'pi CLI not found — install with: npm install -g @anthropic-ai/claude-code',
    };
  }

  private static checkApiKey(): PrerequisiteResult {
    const key = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    return {
      name: 'API key',
      ok: key.length > 0,
      message: key ? 'found' : 'set OPENROUTER_API_KEY or ANTHROPIC_API_KEY',
    };
  }

  static format(results: PrerequisiteResult[]): string {
    const lines = results.map(r =>
      `  ${r.ok ? '✅' : '❌'} ${r.name}: ${r.message}`);
    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      lines.push(`\n  ${failed.length} issue(s) found. Fix before running.`);
    }
    return lines.join('\n');
  }
}
