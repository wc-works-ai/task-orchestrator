import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const LOG_TRUNCATED_MARKER = '\n=== agent.log truncated; keeping latest output only ===\n';

export interface AgentLog {
  readonly path: string;
  readonly maxBytes: number;
  bytes: number;
}

export function openAgentLog(path: string, maxBytes: number): AgentLog {
  try { writeFileSync(path, ''); } catch {}
  return { path, maxBytes, bytes: 0 };
}

export function appendAgentLog(log: AgentLog, text: string): void {
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
