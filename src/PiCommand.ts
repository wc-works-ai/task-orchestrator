import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';

const PI_COMMAND = 'pi';
const PI_CMD_SHIM = 'pi.cmd';
const NPM_CMD_TARGET = /"%dp0%\\([^"]+)"\s+%\*/i;

export interface PiCommand {
  readonly command: string;
  readonly args: string[];
}

export function piCommand(args: readonly string[]): PiCommand {
  const copiedArgs = [...args];
  if (process.platform !== 'win32') return { command: PI_COMMAND, args: copiedArgs };

  const entrypoint = windowsPiEntrypoint();
  if (!entrypoint) return { command: PI_COMMAND, args: copiedArgs };

  return { command: process.execPath, args: [entrypoint, ...copiedArgs] };
}

function windowsPiEntrypoint(): string | undefined {
  const shimPath = windowsPiShimPath();
  if (!shimPath) return undefined;

  const target = NPM_CMD_TARGET.exec(readFileSync(shimPath, 'utf-8'))?.[1];
  if (!target) return undefined;

  return win32.join(win32.dirname(shimPath), target);
}

function windowsPiShimPath(): string | undefined {
  const result = spawnSync('where.exe', [PI_CMD_SHIM], { timeout: 5000, encoding: 'utf-8' });
  if (result.status !== 0) return undefined;

  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(path => path.length > 0 && existsSync(path));
}
