import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { branches: 90, functions: 95, lines: 98, statements: 95 },
      exclude: ['vitest.config.ts'],
    },
  },
});
