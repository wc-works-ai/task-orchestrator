export function stamp(now: Date = new Date()): string {
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const millis = String(now.getMilliseconds()).padStart(3, '0');
  return `[${hours}:${minutes}:${seconds}.${millis}]`;
}

export function consumeLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = `${buffer}${chunk}`.split('\n');
  const rest = parts.pop() as string;
  const lines = parts.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  return { lines, rest };
}

export function formatRawLine(line: string, now: Date = new Date()): string {
  return `${stamp(now)} ${line}`;
}

export function formatPiEvent(event: Record<string, unknown>, now: Date = new Date()): string[] {
  const type = asString(event.type);
  if (type === undefined) return [];

  if (type === 'message_start') return [];
  if (type === 'message_end') return formatMessageEnd(event, now);
  if (/tool/i.test(type)) return [formatTopLevelTool(event, now)];
  if (type === 'text') return [`${stamp(now)} text: ${summarize(event.text)}`];

  return [formatGeneric(event, type, now)];
}

function formatMessageEnd(event: Record<string, unknown>, now: Date): string[] {
  const message = asRecord(event.message);
  const role = asString(message?.role);
  const content = message?.content;

  if (role === 'assistant') {
    const usage = formatUsage(message?.usage);
    const lines = [`${stamp(now)} LLM assistant turn${usage === '' ? '' : ` — ${usage}`}`];
    if (Array.isArray(content)) {
      lines.push(...formatContentBlocks(content, now, false));
    }
    return lines;
  }

  if (role === 'user' && Array.isArray(content)) {
    return formatContentBlocks(content, now, true);
  }

  return [];
}

function formatContentBlocks(blocks: unknown[], now: Date, toolResultsOnly: boolean): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined) continue;

    const type = asString(record.type);
    if (toolResultsOnly && type !== 'tool_result') continue;
    lines.push(formatContentBlock(record, type, now));
  }
  return lines;
}

function formatContentBlock(block: Record<string, unknown>, type: string | undefined, now: Date): string {
  const prefix = stamp(now);
  if (type === 'tool_use' || type === 'tool_call') {
    const name = toolName(block);
    const args = block.input ?? block.args ?? block.arguments;
    return `${prefix} TOOL ${name}(${summarize(args)})`;
  }

  if (type === 'text') {
    return `${prefix} text: ${summarize(block.text)}`;
  }

  if (type === 'tool_result') {
    const result = block.content ?? block.result ?? block.output;
    return `${prefix} TOOL result: ${summarize(result)}`;
  }

  return `${prefix} · ${type ?? 'content'}`;
}

function formatTopLevelTool(event: Record<string, unknown>, now: Date): string {
  const prefix = stamp(now);
  const name = toolName(event);
  if ('result' in event || 'output' in event) {
    const result = 'result' in event ? event.result : event.output;
    return `${prefix} TOOL ${name} -> ${summarize(result)}`;
  }

  const args = event.input ?? event.args ?? event.arguments ?? event.parameters;
  return `${prefix} TOOL ${name}(${summarize(args)})`;
}

function formatGeneric(event: Record<string, unknown>, type: string, now: Date): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key !== 'type') rest[key] = value;
  }

  return `${stamp(now)} · ${type} ${summarize(rest)}`;
}

function formatUsage(value: unknown): string {
  const usage = asRecord(value);
  if (usage === undefined) return '';

  const input = pickNumber(usage, ['input', 'input_tokens', 'prompt_tokens']);
  const output = pickNumber(usage, ['output', 'output_tokens', 'completion_tokens']);
  const cacheRead = pickNumber(usage, ['cacheRead', 'cache_read', 'cached_tokens']);
  const cacheWrite = pickNumber(usage, ['cacheWrite', 'cache_write', 'cache_write_tokens']);
  const total = pickNumber(usage, ['totalTokens', 'total_tokens']) ?? sumNumbers([input, output, cacheRead, cacheWrite]);
  if (total === undefined) return '';

  const details: string[] = [];
  if (input !== undefined) details.push(`in=${input}`);
  if (output !== undefined) details.push(`out=${output}`);
  if (cacheRead !== undefined || cacheWrite !== undefined) details.push(`cache=${(cacheRead ?? 0) + (cacheWrite ?? 0)}`);

  return details.length === 0 ? `${total} tokens` : `${total} tokens (${details.join(' ')})`;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function sumNumbers(values: Array<number | undefined>): number | undefined {
  let total = 0;
  let found = false;
  for (const value of values) {
    if (value !== undefined) {
      total += value;
      found = true;
    }
  }
  return found ? total : undefined;
}

function toolName(record: Record<string, unknown>): string {
  return asString(record.name ?? record.tool ?? record.tool_name ?? record.toolName) ?? 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function summarize(value: unknown, max = 120): string {
  if (value === null || value === undefined) return '';

  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw === undefined) return '';

  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
