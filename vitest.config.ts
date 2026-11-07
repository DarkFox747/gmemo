import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // DB-backed suites share one database and reset its schema, so they must
    // not run concurrently. Unit-only runs (no DATABASE_URL) stay parallel.
    fileParallelism: !process.env.DATABASE_URL,
  },
});
