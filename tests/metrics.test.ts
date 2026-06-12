import { describe, expect, it } from 'vitest';
import { parseMetrics, unmetSummary } from '../src/metrics.js';

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
});
