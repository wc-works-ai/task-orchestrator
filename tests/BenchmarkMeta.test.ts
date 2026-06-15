import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  sha256, readMeta, writeMeta, shouldRegenerate, type BenchmarkMeta,
} from '../src/BenchmarkMeta.js';

const META = (over: Partial<BenchmarkMeta> = {}): BenchmarkMeta => ({
  fingerprint: 'fp', base: 'sha-a', hash: 'h', genAttempts: 0, ...over,
});

describe('BenchmarkMeta', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'bmeta-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('sha256', () => {
    it('is a stable 64-hex digest that differs by input', () => {
      expect(sha256('a')).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256('a')).toBe(sha256('a'));
      expect(sha256('a')).not.toBe(sha256('b'));
    });
  });

  describe('readMeta / writeMeta', () => {
    it('round-trips a written meta file', () => {
      const m = META({ base: 'sha-xyz', genAttempts: 2 });
      writeMeta(dir, m);
      expect(readMeta(dir)).toEqual(m);
    });

    it('returns null when no meta file exists', () => {
      expect(readMeta(dir)).toBeNull();
    });

    it('returns null when the meta file is corrupt', () => {
      writeFileSync(join(dir, 'benchmark.meta.json'), 'not json {');
      expect(readMeta(dir)).toBeNull();
    });
  });

  describe('shouldRegenerate', () => {
    it('freezes during a convergence streak even when other triggers fire', () => {
      expect(shouldRegenerate({
        convergenceCount: 1, benchmarkExists: false, meta: null,
        fingerprint: 'fp', baseSha: 'sha-a',
      })).toBe(false);
    });

    it('regenerates when benchmark.js is missing', () => {
      expect(shouldRegenerate({
        convergenceCount: 0, benchmarkExists: false, meta: null,
        fingerprint: 'fp', baseSha: 'sha-a',
      })).toBe(true);
    });

    it('regenerates when provenance meta is absent', () => {
      expect(shouldRegenerate({
        convergenceCount: 0, benchmarkExists: true, meta: null,
        fingerprint: 'fp', baseSha: 'sha-a',
      })).toBe(true);
    });

    it('regenerates when the acceptance-criteria fingerprint changed', () => {
      expect(shouldRegenerate({
        convergenceCount: 0, benchmarkExists: true, meta: META({ fingerprint: 'old' }),
        fingerprint: 'new', baseSha: 'sha-a',
      })).toBe(true);
    });

    it('regenerates when the base SHA advanced', () => {
      expect(shouldRegenerate({
        convergenceCount: 0, benchmarkExists: true, meta: META({ fingerprint: 'fp', base: 'sha-a' }),
        fingerprint: 'fp', baseSha: 'sha-b',
      })).toBe(true);
    });

    it('keeps the frozen benchmark when nothing changed', () => {
      expect(shouldRegenerate({
        convergenceCount: 0, benchmarkExists: true, meta: META({ fingerprint: 'fp', base: 'sha-a' }),
        fingerprint: 'fp', baseSha: 'sha-a',
      })).toBe(false);
    });
  });
});
