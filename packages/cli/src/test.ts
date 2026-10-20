import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type AssumeEntry,
  type LoadedProject,
  loadFiles,
  MocksError,
  renderAnnotations,
  renderJUnit,
  renderTextReport,
  type RunOptions,
  type RunResult,
  runTests,
} from '@simulci/engine';
import {
  AssumeError,
  discoverTests,
  diskSnapshotStore,
  misplacedTests,
  readTests,
  readWorkflowFiles,
  TESTS_DIR,
  TestsError,
} from '@simulci/node';
import { type ArgsDef, defineCommand } from 'citty';
import { assumeOf, readArgs, values } from './args';

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
    snapshots: diskSnapshotStore(root),
  };
  if (a.filter !== undefined) options.filter = a.filter;
  if (cli.length) options.cli = cli;
  let result: RunResult;
  try {
    result = runTests(ready.project, readTests(root, files), options);
  } catch (e) {
    if (!(e instanceof MocksError || e instanceof TestsError)) throw e;
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
  const files = discoverTests(root, values(a.files));
  const misplaced = misplacedTests(files);
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
    return { root, files, project: loadFiles(workflows), cli: assumeOf(a.assume, a.assumeFile) };
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

const TEST_ARGS = {
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
} satisfies ArgsDef;

export const testCommand = defineCommand({
  meta: { name: 'test', description: 'Run the route tests under .github/simulci/tests' },
  args: TEST_ARGS,
  run({ rawArgs }) {
    process.exitCode = runTestCommand(testArgs(rawArgs), {
      stdout: (t) => process.stdout.write(t),
      stderr: (t) => process.stderr.write(t),
      env: process.env,
    });
  },
});

/** The arguments of a `simulci test` command line: every test file named, and every `--assume`. */
export function testArgs(rawArgs: readonly string[]): TestArgs {
  const a = readArgs(rawArgs, TEST_ARGS, { repeated: ['assume'] }) as unknown as TestArgs & { _: string[] };
  return a._.length ? { ...a, files: a._ } : a;
}
