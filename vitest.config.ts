import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { branches: 78, functions: 90, lines: 94, statements: 90 },
      exclude: ['vitest.config.ts'],
    },
  },
});
