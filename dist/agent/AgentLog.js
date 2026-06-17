import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const LOG_TRUNCATED_MARKER = '\n=== agent.log truncated; keeping latest output only ===\n';
/**
 * Filesystem-safe log file name for a single agent run, e.g.
 * `agent-20260612-183318-007.log`. Each spawn/retry gets its own file so
 * earlier runs are preserved instead of overwritten. Local time, no colons
 * (Windows-safe).
 */
export function runLogName(now = new Date()) {
    const p2 = (n) => String(n).padStart(2, '0');
    const p3 = (n) => String(n).padStart(3, '0');
    const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
        `-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}` +
        `-${p3(now.getMilliseconds())}`;
    return `agent-${stamp}.log`;
}
export function openAgentLog(path, maxBytes) {
    try {
        writeFileSync(path, '');
    }
    catch (error) {
        console.error(`[AgentLog] failed to initialize ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { path, maxBytes, bytes: 0 };
}
export function appendAgentLog(log, text) {
    const chunk = Buffer.from(text);
    if (log.bytes + chunk.length <= log.maxBytes) {
        appendFileSync(log.path, chunk);
        log.bytes += chunk.length;
        return;
    }
    const marker = Buffer.from(LOG_TRUNCATED_MARKER);
    const available = log.maxBytes - marker.length;
    if (available <= 0) {
        const next = marker.subarray(0, log.maxBytes);
        writeFileSync(log.path, next);
        log.bytes = next.length;
        return;
    }
    const chunkBytes = Math.min(chunk.length, available);
    const existingBytes = available - chunkBytes;
    const existing = existingBytes > 0
        ? readFileSync(log.path).subarray(Math.max(0, log.bytes - existingBytes))
        : Buffer.alloc(0);
    const next = Buffer.concat([
        marker,
        existing,
        chunk.subarray(chunk.length - chunkBytes),
    ]);
    writeFileSync(log.path, next);
    log.bytes = next.length;
}
//# sourceMappingURL=AgentLog.js.map