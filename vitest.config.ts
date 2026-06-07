import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { branches: 80, functions: 90, lines: 95, statements: 93 },
      exclude: ['vitest.config.ts'],
    },
  },
});
