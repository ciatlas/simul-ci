#!/usr/bin/env node
/**
 * The browser bundle's contract, checked from the source maps of `apps/web/dist`:
 * - the engine (and with it @ciatlas/core, zod, yaml, @actions/*, picomatch) lives only in the worker chunk;
 * - the worker chunk is built from core's browser entry (no node-fs, no git);
 * - no chunk imports a Node built-in;
 * - every chunk stays under its gzip budget.
 * Usage: node scripts/check-web-bundle.mjs [apps/web/dist]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = process.argv[2] ?? 'apps/web/dist';
const assets = join(dist, 'assets');

/** Gzip budgets in kB, 15 % above the figures measured when the budget was set; raise them on purpose. */
const BUDGETS = [
  { name: 'the engine worker', test: (f) => f.startsWith('engine.worker-'), kB: 170 },
  { name: 'the page', test: (f) => f.startsWith('index-') && f.endsWith('.js'), kB: 130 },
];

/** What may only appear in the worker chunk. */
const WORKER_ONLY = [
  /@ciatlas\/core\//,
  /\/@actions\//,
  /\/zod\//,
  /\/yaml\//,
  /picomatch/,
  /\/elkjs\//,
  /cronstrue/,
];
/** Engine sources the page may use: the core-free entries. */
const PAGE_ENGINE_OK = /packages\/engine\/src\/(plan|render)\//;
const ENGINE = /packages\/engine\/src\//;

const problems = [];
const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
if (files.length === 0) problems.push(`no JavaScript chunk under ${assets}`);

const rows = [];
for (const file of files) {
  const code = readFileSync(join(assets, file), 'utf8');
  const gz = gzipSync(code).length / 1024;
  const isWorker = file.startsWith('engine.worker-');
  if (/from ?['"]node:|require\(['"]node:/.test(code)) problems.push(`${file} imports a Node built-in`);
  let sources = [];
  try {
    sources = JSON.parse(readFileSync(join(assets, `${file}.map`), 'utf8')).sources ?? [];
  } catch {
    problems.push(`${file} has no source map to check`);
  }
  if (isWorker) {
    if (!sources.some((s) => s.includes('project-browser')))
      problems.push(`${file} was not built from core's browser entry`);
    for (const s of sources)
      if (/node-fs\.ts|\/git\.ts/.test(s) && s.includes('@ciatlas/core')) problems.push(`${file} holds ${s}`);
  } else {
    for (const s of sources) {
      if (WORKER_ONLY.some((re) => re.test(s)))
        problems.push(`${file} holds ${s}, which only the worker may`);
      if (ENGINE.test(s) && !PAGE_ENGINE_OK.test(s))
        problems.push(`${file} holds ${s}: the page may use only plan/ and render/`);
    }
  }
  const byPackage = new Map();
  for (const s of sources) {
    const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(s);
    const key = m
      ? m[1]
      : s.includes('packages/')
        ? s.replace(/.*packages\/([^/]+).*/, '@simulci/$1')
        : 'app';
    byPackage.set(key, (byPackage.get(key) ?? 0) + 1);
  }
  rows.push({ file, kB: statSync(join(assets, file)).size / 1024, gz, packages: byPackage });
  const budget = BUDGETS.find((b) => b.test(file));
  if (budget && gz > budget.kB)
    problems.push(`${file} is ${gz.toFixed(1)} kB gzipped; the budget for ${budget.name} is ${budget.kB} kB`);
}

const table = ['| chunk | kB | gzip kB | sources |', '|---|---:|---:|---|'];
for (const r of rows) {
  const top = [...r.packages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  table.push(
    `| ${r.file} | ${r.kB.toFixed(0)} | ${r.gz.toFixed(1)} | ${top.map(([k, n]) => `${k} (${n})`).join(', ')} |`,
  );
}
const report = table.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Browser bundle\n\n${report}\n`);
}
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('the browser bundle keeps its contract');
