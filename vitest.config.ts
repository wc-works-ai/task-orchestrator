import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { branches: 55, functions: 65, lines: 70, statements: 65 },
      exclude: ['vitest.config.ts'],
    },
  },
});
