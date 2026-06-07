import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // v8 provider has known gaps with single-line getters and conditional
      // chains. 95/90/95/97 is the practical ceiling without code restructuring.
      thresholds: { branches: 90, functions: 95, lines: 97, statements: 95 },
      exclude: ['vitest.config.ts'],
    },
  },
});
