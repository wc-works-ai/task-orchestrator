import { defineConfig } from 'vitest/config';

// Prevent tests from accessing the user's global OR the machine's system gitconfig
// (the system one sets core.autocrlf=true on Windows, which warns on LF fixtures).
const GIT_ENV = { GIT_CONFIG_GLOBAL: '', GIT_CONFIG_NOSYSTEM: '1' };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          env: GIT_ENV,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          env: GIT_ENV,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          env: GIT_ENV,
          // E2E spawns real CLI processes + git, so each test is seconds-slow and
          // must not contend for CPU. Generous timeout + sequential execution.
          testTimeout: 30000,
          hookTimeout: 30000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: { 100: true },
      exclude: ['vitest.config.ts', 'src/shared/env.ts'],
    },
  },
});
