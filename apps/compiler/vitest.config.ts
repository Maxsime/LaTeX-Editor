import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Containers take a while to pull and start on a cold CI runner.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
