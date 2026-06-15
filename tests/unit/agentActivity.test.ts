import { describe, expect, it } from 'vitest';
import { consumeLines, formatPiEvent, formatRawLine, stamp } from '../../src/agent/agentActivity.js';

const NOW = new Date(2026, 0, 2, 9, 5, 4, 7);
const PREFIX = '[09:05:04.007]';

describe('agentActivity', () => {
  describe('stamp', () => {
    it('formats a zero-padded local timestamp', () => {
      expect(stamp(NOW)).toBe(PREFIX);
    });
  });

  describe('consumeLines', () => {
    it('keeps all text as rest when there is no newline', () => {
      expect(consumeLines('', 'partial')).toEqual({ lines: [], rest: 'partial' });
    });

    it('returns one complete line and empty rest', () => {
      expect(consumeLines('', 'line\n')).toEqual({ lines: ['line'], rest: '' });
    });

    it('returns multiple complete lines', () => {
      expect(consumeLines('', 'one\ntwo\n')).toEqual({ lines: ['one', 'two'], rest: '' });
    });

    it('strips CR from CRLF lines', () => {
      expect(consumeLines('', 'one\r\ntwo\r\n')).toEqual({ lines: ['one', 'two'], rest: '' });
    });

    it('combines buffer with chunk and preserves a trailing partial line', () => {
      expect(consumeLines('part', 'ial\nnext')).toEqual({ lines: ['partial'], rest: 'next' });
    });

    it('preserves empty complete lines', () => {
      expect(consumeLines('', '\n\n')).toEqual({ lines: ['', ''], rest: '' });
    });

    it('handles empty input', () => {
      expect(consumeLines('', '')).toEqual({ lines: [], rest: '' });
    });
  });

  describe('formatRawLine', () => {
    it('prefixes raw text with a timestamp', () => {
      expect(formatRawLine('hello', NOW)).toBe(`${PREFIX} hello`);
    });
  });

  describe('formatPiEvent', () => {
    it('skips message_start events', () => {
      expect(formatPiEvent({ type: 'message_start', message: { role: 'user' } }, NOW)).toEqual([]);
    });

    it('formats assistant message_end usage with canonical keys', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, totalTokens: 350 },
        },
      }, NOW)).toEqual([`${PREFIX} LLM assistant turn — 350 tokens (in=100 out=50 cache=200)`]);
    });

    it('formats assistant message_end usage with alternate keys and computed total', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3, cache_write_tokens: 2 },
        },
      }, NOW)).toEqual([`${PREFIX} LLM assistant turn — 20 tokens (in=10 out=5 cache=5)`]);
    });

    it('formats other alternate usage keys', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input_tokens: 7, output_tokens: 4, cache_read: 2, cache_write: 1, total_tokens: 14 },
        },
      }, NOW)).toEqual([`${PREFIX} LLM assistant turn — 14 tokens (in=7 out=4 cache=3)`]);
    });

    it('formats assistant message_end without usage', () => {
      expect(formatPiEvent({ type: 'message_end', message: { role: 'assistant' } }, NOW))
        .toEqual([`${PREFIX} LLM assistant turn`]);
    });

    it('summarizes assistant content blocks', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            'ignored',
            { type: 'tool_use', name: 'bash', input: { command: 'npm run c' } },
            { type: 'text', text: 'hello\nworld' },
            { type: 'tool_result', content: [{ type: 'text', text: 'ok' }] },
            { type: 'thinking' },
            {},
          ],
        },
      }, NOW)).toEqual([
        `${PREFIX} LLM assistant turn`,
        `${PREFIX} TOOL bash({"command":"npm run c"})`,
        `${PREFIX} text: hello world`,
        `${PREFIX} TOOL result: [{"type":"text","text":"ok"}]`,
        `${PREFIX} · thinking`,
        `${PREFIX} · content`,
      ]);
    });

    it('formats total-only assistant usage and ignores invalid numbers', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: Number.POSITIVE_INFINITY, total_tokens: 9 } },
      }, NOW)).toEqual([`${PREFIX} LLM assistant turn — 9 tokens`]);
    });

    it('omits assistant usage when no numeric usage values are present', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 'bad' } },
      }, NOW)).toEqual([`${PREFIX} LLM assistant turn`]);
    });

    it('computes usage from cache writes only', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: { role: 'assistant', usage: { cache_write: 2 } },
      }, NOW)).toEqual([`${PREFIX} LLM assistant turn — 2 tokens (cache=2)`]);
    });

    it('computes usage from cache reads only', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: { role: 'assistant', usage: { cache_read: 2 } },
      }, NOW)).toEqual([`${PREFIX} LLM assistant turn — 2 tokens (cache=2)`]);
    });

    it('skips user message_end without tool results', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
      }, NOW)).toEqual([]);
    });

    it('skips user message_end without content', () => {
      expect(formatPiEvent({ type: 'message_end', message: { role: 'user' } }, NOW)).toEqual([]);
    });

    it('summarizes user message_end tool results', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'tool_result', result: 'done' }] },
      }, NOW)).toEqual([`${PREFIX} TOOL result: done`]);
    });

    it('uses content-block fallback fields for tool args and results', () => {
      expect(formatPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_call', name: 'argsTool', args: { a: 1 } },
            { type: 'tool_call', name: 'argumentsTool', arguments: { b: 2 } },
            { type: 'tool_result', output: 'stdout' },
          ],
        },
      }, NOW)).toEqual([
        `${PREFIX} LLM assistant turn`,
        `${PREFIX} TOOL argsTool({"a":1})`,
        `${PREFIX} TOOL argumentsTool({"b":2})`,
        `${PREFIX} TOOL result: stdout`,
      ]);
    });

    it('formats top-level tool calls with args', () => {
      expect(formatPiEvent({ type: 'tool_call', tool_name: 'edit', arguments: { file: 'a.ts' } }, NOW))
        .toEqual([`${PREFIX} TOOL edit({"file":"a.ts"})`]);
    });

    it('formats top-level tool calls with input, args, and parameters fallbacks', () => {
      expect(formatPiEvent({ type: 'tool_call', name: 'inputTool', input: { a: 1 } }, NOW))
        .toEqual([`${PREFIX} TOOL inputTool({"a":1})`]);
      expect(formatPiEvent({ type: 'tool_call', name: 'argsTool', args: { b: 2 } }, NOW))
        .toEqual([`${PREFIX} TOOL argsTool({"b":2})`]);
      expect(formatPiEvent({ type: 'tool_call', name: 'paramsTool', parameters: { c: 3 } }, NOW))
        .toEqual([`${PREFIX} TOOL paramsTool({"c":3})`]);
    });

    it('formats top-level tool results with output', () => {
      expect(formatPiEvent({ type: 'tool_result', tool: 'bash', output: 'passed' }, NOW))
        .toEqual([`${PREFIX} TOOL bash -> passed`]);
    });

    it('formats top-level tool results with result and fallback name', () => {
      expect(formatPiEvent({ type: 'tool_result', result: 'done' }, NOW))
        .toEqual([`${PREFIX} TOOL unknown -> done`]);
    });

    it('formats top-level text', () => {
      expect(formatPiEvent({ type: 'text', text: 'hello   there' }, NOW))
        .toEqual([`${PREFIX} text: hello there`]);
    });

    it('formats empty summaries for null and non-json values', () => {
      expect(formatPiEvent({ type: 'text', text: null }, NOW)).toEqual([`${PREFIX} text: `]);
      expect(formatPiEvent({ type: 'text', text: Symbol('no-json') }, NOW)).toEqual([`${PREFIX} text: `]);
    });

    it('formats unknown events with compact summaries', () => {
      expect(formatPiEvent({ type: 'custom_event', value: 42 }, NOW))
        .toEqual([`${PREFIX} · custom_event {"value":42}`]);
    });

    it('skips events with missing or non-string type', () => {
      expect(formatPiEvent({}, NOW)).toEqual([]);
      expect(formatPiEvent({ type: 3 }, NOW)).toEqual([]);
    });

    it('truncates long string summaries', () => {
      const [line] = formatPiEvent({ type: 'text', text: 'x'.repeat(140) }, NOW);
      expect(line).toBe(`${PREFIX} text: ${'x'.repeat(119)}…`);
    });

    it('truncates object summaries', () => {
      const [line] = formatPiEvent({ type: 'unknown', value: { text: 'x'.repeat(140) } }, NOW);
      expect(line).toBe(`${PREFIX} · unknown {"value":{"text":"${'x'.repeat(101)}…`);
    });
  });
});
