#!/usr/bin/env node
// Fails unless `npm pack` for the CLI contains exactly the files users need and the manifest declares no runtime
// dependencies (everything is bundled, so installing simulci downloads nothing else). Run from packages/cli after
// `pnpm build`.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const files = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8' }))[0]
  .files.map((f) => f.path)
  .sort();
const expected = ['LICENSE', 'README.md', 'dist/index.js', 'package.json'];
if (JSON.stringify(files) !== JSON.stringify(expected))
  fail(`unexpected tarball contents: ${files.join(', ')} (expected ${expected.join(', ')})`);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length)
  fail('the published package must have no dependencies');
if (pkg.bin?.simulci !== 'dist/index.js') fail('bin.simulci must be dist/index.js');
const version = readFileSync('../engine/src/version.ts', 'utf8').match(/VERSION = '([^']+)'/)?.[1];
if (version !== pkg.version) fail(`package.json version ${pkg.version} does not match VERSION ${version}`);
console.log(`simulci ${pkg.version}: ${files.length} files, no dependencies`);
