import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // @ciatlas/core is a git dependency that ships its TypeScript source (github:ciatlas/core#vX.Y.Z), never built.
      '@ciatlas/core': fileURLToPath(new URL('./node_modules/@ciatlas/core/src/index.ts', import.meta.url)),
      '@simulci/engine': src('engine'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    // @actions/workflow-parser imports JSON without import attributes; let Vite transform it like a bundler does.
    server: { deps: { inline: [/@actions\/workflow-parser/, /@actions\/expressions/, /@ciatlas\/core/] } },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: {
        lines: 80,
        'packages/engine/src/**': { lines: 90 },
      },
    },
  },
});
