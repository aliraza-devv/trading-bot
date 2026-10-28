import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Engine + lib tests are plain TypeScript (no DOM, no Next), so the default node environment works.
export default defineConfig({
  resolve: { alias: { '@engine': path.resolve(import.meta.dirname, 'packages/engine') } },
  // The live-engine replay tests re-run the detectors on thousands of prefixes (2-4 s each on an idle machine), so the
  // 5 s default flakes when the machine is busy.
  test: { include: ['packages/**/*.test.ts', 'lib/**/*.test.ts'], testTimeout: 30_000 },
});
