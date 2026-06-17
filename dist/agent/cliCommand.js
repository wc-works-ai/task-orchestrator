import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';
const NPM_CMD_TARGET = /"%dp0%\\([^"]+)"\s+%\*/i;
export function resolveCliCommand(bin, args) {
    const copiedArgs = [...args];
    if (process.platform !== 'win32')
        return { command: bin, args: copiedArgs };
    const entrypoint = windowsCliEntrypoint(bin);
    if (!entrypoint)
        return { command: bin, args: copiedArgs };
    return { command: process.execPath, args: [entrypoint, ...copiedArgs] };
}
function windowsCliEntrypoint(bin) {
    const shimPath = windowsCliShimPath(`${bin}.cmd`);
    if (!shimPath)
        return undefined;
    const target = NPM_CMD_TARGET.exec(readFileSync(shimPath, 'utf-8'))?.[1];
    if (!target)
        return undefined;
    return win32.join(win32.dirname(shimPath), target);
}
function windowsCliShimPath(cmdShim) {
    const result = spawnSync('where.exe', [cmdShim], { timeout: 5000, encoding: 'utf-8' });
    if (result.status !== 0)
        return undefined;
    return result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(path => path.length > 0 && existsSync(path));
}
//# sourceMappingURL=cliCommand.js.map