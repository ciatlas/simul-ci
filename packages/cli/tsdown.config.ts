import { defineConfig } from 'tsdown';

export default defineConfig({
  // dist/index.js is the `simulci` command. Everything is bundled (the engine, @ciatlas/core and every dependency):
  // the published package has no runtime dependencies.
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  fixedExtension: false,
  dts: false,
  deps: { neverBundle: [] },
  inputOptions: {
    // The engine and @ciatlas/core ship TypeScript source under the `source` export condition.
    resolve: { conditionNames: ['source', 'node', 'import', 'default'] },
  },
});
