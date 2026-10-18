import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  type AssumeEntry,
  type LoadedProject,
  loadFiles,
  MocksError,
  type RunOptions,
  type RunResult,
  runTests,
  type Snapshot,
  type SnapshotStore,
} from '@simulci/engine';
import { defineCommand } from 'citty';
import { AssumeError, parseAssume } from './assume';
import { readWorkflowFiles } from './files';
import { renderAnnotations, renderJUnit, renderTextReport } from './report';

/** `simulci test`: the route tests under `.github/simulci/tests`, or the files named. */

export interface TestArgs {
  dir: string;
  files?: string | string[];
  junit?: string;
  update?: boolean;
  snapshotDetail?: string;
  filter?: string;
  ci?: boolean;
  strict?: boolean;
  annotations?: boolean;
  assume?: string | string[];
  assumeFile?: string;
}

export interface TestIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

const TESTS_DIR = '.github/simulci/tests';

/** Runs the command; returns the exit code. */
export function runTestCommand(a: TestArgs, io: TestIo): number {
  const ready = prepare(a, io);
  if (typeof ready === 'number') return ready;
  const { root, files, cli } = ready;
  const options: RunOptions = {
    ci: a.ci ?? io.env.CI === 'true',
    update: a.update ?? false,
    strict: a.strict ?? false,
    snapshotDetail: a.snapshotDetail === 'legs' ? 'legs' : 'steps',
    snapshots: diskStore(root),
  };
  if (a.filter !== undefined) options.filter = a.filter;
  if (cli.length) options.cli = cli;
  let result: RunResult;
  try {
    result = runTests(
      ready.project,
      files.map((f) => ({ path: f, text: readFileSync(join(root, f), 'utf8') })),
      options,
    );
  } catch (e) {
    if (!(e instanceof MocksError)) throw e;
    io.stderr(`${e.message}\n`);
    return 2;
  }
  report(result, a, io);
  return result.exitCode;
}

interface Prepared {
  root: string;
  files: string[];
  project: LoadedProject;
  cli: AssumeEntry[];
}

/** The checkout, the test files, the project and the cli mocks; or the exit code when one of them is not there. */
function prepare(a: TestArgs, io: TestIo): Prepared | number {
  const root = resolve(a.dir);
  const files = discover(root, list(a.files));
  const misplaced = files.filter((f) => /(^|\/)\.github\/workflows\//.test(f));
  if (misplaced.length) {
    io.stderr(
      `T000 ${misplaced.join(', ')}: a test file under .github/workflows would be run by GitHub; put it under ${TESTS_DIR}\n`,
    );
    return 2;
  }
  const workflows = readWorkflowFiles(root);
  if (Object.keys(workflows).length === 0) {
    io.stderr(`no workflows under ${a.dir}/.github/workflows\n`);
    return 2;
  }
  try {
    const fileText = a.assumeFile === undefined ? undefined : readFileSync(resolve(a.assumeFile), 'utf8');
    return { root, files, project: loadFiles(workflows), cli: parseAssume(list(a.assume), fileText) };
  } catch (e) {
    if (!(e instanceof AssumeError)) throw e;
    io.stderr(`${e.message}\n`);
    return 2;
  }
}

function report(result: RunResult, a: TestArgs, io: TestIo): void {
  io.stdout(renderTextReport(result));
  if (a.annotations ?? io.env.GITHUB_ACTIONS === 'true')
    for (const line of renderAnnotations(result)) io.stdout(`${line}\n`);
  if (a.junit !== undefined) {
    mkdirSync(dirname(resolve(a.junit)), { recursive: true });
    writeFileSync(resolve(a.junit), renderJUnit(result));
  }
}

/** The named files (relative to the checkout), else every `*.test.yml` under the tests directory. */
function discover(root: string, named: string[]): string[] {
  if (named.length) return named.map((f) => relative(root, resolve(f)).split('\\').join('/'));
  const dir = join(root, TESTS_DIR);
  if (!existsSync(dir)) return [];
  return walk(dir)
    .filter((f) => /\.test\.ya?ml$/.test(f) && !f.includes('/__snapshots__/'))
    .map((f) => relative(root, f).split('\\').join('/'))
    .sort((x, y) => x.localeCompare(y));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** `<tests dir>/__snapshots__/<name>.test.snap.json` beside the tests. */
export function snapshotPath(testFile: string): string {
  const name = testFile.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
  return `${dirname(testFile)}/__snapshots__/${name}.snap.json`;
}

function diskStore(root: string): SnapshotStore {
  return {
    read(testFile) {
      const file = join(root, snapshotPath(testFile));
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
    },
    write(testFile, snapshot) {
      const file = join(root, snapshotPath(testFile));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    },
  };
}

const list = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export const testCommand = defineCommand({
  meta: { name: 'test', description: 'Run the route tests under .github/simulci/tests' },
  args: {
    files: {
      type: 'positional',
      description: 'Test files (default: every *.test.yml under .github/simulci/tests)',
      required: false,
    },
    dir: { type: 'string', description: 'The repository checkout', default: '.' },
    junit: { type: 'string', description: 'Write a JUnit report to this file' },
    update: {
      type: 'boolean',
      alias: 'u',
      description: 'Write every snapshot and prune stale ones',
      default: false,
    },
    snapshotDetail: { type: 'string', description: 'steps or legs', default: 'steps' },
    filter: { type: 'string', alias: 't', description: 'Run the cases whose name contains the text' },
    ci: {
      type: 'boolean',
      description: 'Never write snapshots; a missing one fails; only is an error (default when CI=true)',
    },
    strict: { type: 'boolean', description: 'Ignore allowMaybe; stale snapshots fail', default: false },
    annotations: {
      type: 'boolean',
      description: 'Print GitHub annotations (default when GITHUB_ACTIONS=true)',
    },
    assume: {
      type: 'string',
      description: 'A mock for every case: build.unit=failure, build.unit.outputs.sha=abc (repeatable)',
    },
    assumeFile: { type: 'string', description: 'A YAML list of mocks for every case' },
  },
  run({ args }) {
    const a = args as unknown as TestArgs & { _?: string[] };
    const files = a._?.length ? a._ : a.files;
    const code = runTestCommand(
      { ...a, ...(files === undefined ? {} : { files }) },
      { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env },
    );
    process.exitCode = code;
  },
});
