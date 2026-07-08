import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests share a single Postgres; run serially to avoid cross-file DB races.
    fileParallelism: false,
    globals: false,
  },
});
