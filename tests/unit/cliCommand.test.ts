import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolveCliCommand } from '../../src/agent/cliCommand.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('resolveCliCommand', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    vi.resetAllMocks();
  });

  it('uses pi directly outside Windows', () => {
    setPlatform('linux');

    const command = resolveCliCommand('pi', ['--version']);

    expect(command).toEqual({ command: 'pi', args: ['--version'] });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('resolves the Windows npm shim to its node entrypoint', () => {
    setPlatform('win32');
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Q:\\.tools\\.npm-global\\pi.cmd\r\n',
    } as ReturnType<typeof spawnSync>);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
    );

    const command = resolveCliCommand('pi', ['--version']);

    expect(command).toEqual({
      command: process.execPath,
      args: [
        'Q:\\.tools\\.npm-global\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js',
        '--version',
      ],
    });
  });

  it('falls back to pi when the Windows shim is unavailable', () => {
    setPlatform('win32');
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as ReturnType<typeof spawnSync>);

    const command = resolveCliCommand('pi', ['--version']);

    expect(command).toEqual({ command: 'pi', args: ['--version'] });
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('falls back to pi when the Windows shim is not an npm cmd shim', () => {
    setPlatform('win32');
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Q:\\.tools\\.npm-global\\pi.cmd\r\n',
    } as ReturnType<typeof spawnSync>);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('not an npm shim');

    const command = resolveCliCommand('pi', ['--version']);

    expect(command).toEqual({ command: 'pi', args: ['--version'] });
  });
});
