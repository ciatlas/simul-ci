import { writeFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

export default defineConfig({
  // The runner executes dist/index.js straight from the repository, so everything is bundled into that one file:
  // @actions/core, the engine, @ciatlas/core and every dependency.
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  clean: true,
  dts: false,
  fixedExtension: false,
  inputOptions: {
    // The engine, @simulci/node and @ciatlas/core ship TypeScript source under the `source` export condition.
    resolve: { conditionNames: ['source', 'node', 'import', 'default'] },
  },
  // The bundle is an ES module in a .js file. Copied out of this repository (a release archive), the nearest
  // package.json would decide how Node reads it, and a "type": "commonjs" one would break it; this one says ESM.
  onSuccess() {
    writeFileSync('dist/package.json', '{\n  "type": "module"\n}\n');
  },
});
