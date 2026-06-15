import { describe, expect, it } from 'vitest';
import { parseMetrics, unmetSummary, classifyBenchmark } from '../../src/shared/metrics.js';

describe('metrics', () => {
  describe('parseMetrics', () => {
    it('parses a single metric', () => {
      const result = parseMetrics('METRIC score=7\n');

      expect(result.total).toBe(7);
      expect(result.criteria).toHaveLength(1);
      expect(result.criteria[0]).toEqual({ name: 'score', value: 7 });
    });

    it('sums multiple metrics and captures all criteria', () => {
      const result = parseMetrics('METRIC lint=2\nnoise\nMETRIC test=3\n');

      expect(result.total).toBe(5);
      expect(result.criteria).toEqual([
        { name: 'lint', value: 2 },
        { name: 'test', value: 3 },
      ]);
    });

    it('returns zero when multiple metrics are all zero', () => {
      const result = parseMetrics('METRIC lint=0\nMETRIC test=0\n');

      expect(result.total).toBe(0);
    });

    it('uses the default fallback when no metric is present', () => {
      const result = parseMetrics('no metrics here\n');

      expect(result.total).toBe(1);
      expect(result.criteria).toEqual([]);
    });

    it('respects a custom fallback when no metric is present', () => {
      const result = parseMetrics('no metrics here\n', 4);

      expect(result.total).toBe(4);
      expect(result.criteria).toEqual([]);
    });

    it('keeps integer-only decimal parsing behavior', () => {
      const result = parseMetrics('METRIC x=42.5\n');

      expect(result.total).toBe(42);
      expect(result.criteria).toEqual([{ name: 'x', value: 42 }]);
    });

    it('with `only`, counts just the declared metric and ignores foreign ones', () => {
      // A leaked `METRIC branch_gap=42.5` (e.g. from echoed test-suite output)
      // must not pollute a task whose metric is `os_specific_test_gap`.
      const result = parseMetrics(
        'METRIC branch_gap=42.5\nnoise\nMETRIC os_specific_test_gap=0\n',
        1,
        ['os_specific_test_gap'],
      );

      expect(result.total).toBe(0);
      expect(result.criteria).toEqual([{ name: 'os_specific_test_gap', value: 0 }]);
    });

    it('with `only`, takes the LAST value emitted for the declared metric', () => {
      const result = parseMetrics('METRIC g=5\nMETRIC g=0\n', 1, ['g']);

      expect(result.total).toBe(0);
      expect(result.criteria).toEqual([{ name: 'g', value: 0 }]);
    });

    it('with `only`, falls back when the declared metric is absent', () => {
      const result = parseMetrics('METRIC other=3\n', 7, ['g']);

      expect(result.total).toBe(7);
      expect(result.criteria).toEqual([]);
    });

    it('with `only`, sums multiple declared metrics', () => {
      const result = parseMetrics('METRIC a=1\nMETRIC branch_gap=9\nMETRIC b=2\n', 1, ['a', 'b']);

      expect(result.total).toBe(3);
      expect(result.criteria).toEqual([{ name: 'a', value: 1 }, { name: 'b', value: 2 }]);
    });
  });

  describe('unmetSummary', () => {
    it('lists only non-zero metrics', () => {
      const result = parseMetrics('METRIC lint=2\nMETRIC test=0\nMETRIC typecheck=3\n');

      expect(unmetSummary(result)).toBe('lint=2, typecheck=3');
    });

    it('returns an empty string when all criteria are zero', () => {
      const result = parseMetrics('METRIC lint=0\nMETRIC test=0\n');

      expect(unmetSummary(result)).toBe('');
    });
  });

  describe('classifyBenchmark', () => {
    it('classifies a crashed run with no output as crash (fallback total)', () => {
      const o = classifyBenchmark('benchmark execution failed', true);

      expect(o.kind).toBe('crash');
      expect(o.total).toBe(1);
      expect(o.criteria).toEqual([]);
    });

    it('classifies a crashed run as crash even when partial metrics leaked', () => {
      // A timeout/non-zero exit makes the result unreliable regardless of any
      // METRIC lines printed before the crash.
      const o = classifyBenchmark('METRIC a=2\n', true);

      expect(o.kind).toBe('crash');
      expect(o.total).toBe(2);
      expect(o.criteria).toEqual([{ name: 'a', value: 2 }]);
    });

    it('classifies a clean run with no METRIC lines as no_metrics (fallback total)', () => {
      const o = classifyBenchmark('ran but printed nothing measurable', false);

      expect(o.kind).toBe('no_metrics');
      expect(o.total).toBe(1);
      expect(o.criteria).toEqual([]);
    });

    it('classifies a clean run with metrics as ok and sums the total', () => {
      const o = classifyBenchmark('METRIC a=1\nMETRIC b=2\n', false);

      expect(o.kind).toBe('ok');
      expect(o.total).toBe(3);
      expect(o.criteria).toEqual([{ name: 'a', value: 1 }, { name: 'b', value: 2 }]);
    });

    it('classifies a clean all-zero run as ok with total 0', () => {
      const o = classifyBenchmark('METRIC a=0\n', false);

      expect(o.kind).toBe('ok');
      expect(o.total).toBe(0);
      expect(o.criteria).toEqual([{ name: 'a', value: 0 }]);
    });

    it('with `only`, a clean run missing the declared metric is no_metrics (custom fallback)', () => {
      const o = classifyBenchmark('METRIC other=3\n', false, ['g'], 7);

      expect(o.kind).toBe('no_metrics');
      expect(o.total).toBe(7);
      expect(o.criteria).toEqual([]);
    });

    it('with `only`, a clean run emitting the declared metric is ok and ignores foreign lines', () => {
      const o = classifyBenchmark('METRIC g=0\nMETRIC noise=9\n', false, ['g']);

      expect(o.kind).toBe('ok');
      expect(o.total).toBe(0);
      expect(o.criteria).toEqual([{ name: 'g', value: 0 }]);
    });
  });
});
