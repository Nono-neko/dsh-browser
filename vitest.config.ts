import { defineConfig } from 'vitest/config'

export default defineConfig({
  // npm SDK packages reference sourcemaps that are not published; do not
  // attempt to load them during transform.
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    pool: 'forks',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // @deepseek-ai SDK packages ship browser bundles (CSS imports included);
    // keep them vite-transformed instead of node-externalized.
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
