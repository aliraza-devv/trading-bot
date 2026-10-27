import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Engine + lib tests are plain TypeScript (no DOM, no Next), so the default node environment works.
export default defineConfig({
  resolve: { alias: { '@engine': path.resolve(import.meta.dirname, 'packages/engine') } },
  test: { include: ['packages/**/*.test.ts', 'lib/**/*.test.ts'] },
});
