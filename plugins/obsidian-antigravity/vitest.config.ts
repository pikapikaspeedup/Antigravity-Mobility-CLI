import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      // Mock obsidian module for tests
      obsidian: './__tests__/mocks/obsidian.ts',
    },
  },
});
