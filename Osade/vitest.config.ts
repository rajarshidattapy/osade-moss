import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `apps/` too: the main process has logic of its own — what a second instance's argv means,
    // which runtime the daemon runs on — and it went untested for exactly as long as the globs
    // said only packages could hold tests.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // e2e spawns a real substrate and a real agent; gate it behind OSADE_E2E=1 (§20.2).
    testTimeout: 30_000,
    environment: 'node',
    // Integration tests touch real sqlite files; keep them off one another.
    pool: 'forks',
  },
});
