import { defineConfig } from 'tsup';

export default defineConfig({
  // dist/index.js is the `simulci` command. Everything is bundled (the engine, @ciatlas/core and every dependency):
  // the published package has no runtime dependencies.
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  noExternal: [/.*/],
  banner: {
    // Some bundled dependencies are CommonJS and call require(); give the ESM file one. The hashbang comes from
    // src/index.ts, which esbuild keeps above this.
    js: "import { createRequire as __simulciCreateRequire } from 'node:module';\nconst require = __simulciCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.conditions = ['source'];
  },
});
