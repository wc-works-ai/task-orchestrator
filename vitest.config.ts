import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      // Prevent tests from accessing user's ~/.gitconfig (avoids permission errors)
      GIT_CONFIG_GLOBAL: '',
    },
    coverage: {
      provider: 'v8',
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
      exclude: ['vitest.config.ts', 'src/env.ts'],
    },
  },
});
