import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type Annotation,
  annotationsOf,
  type AssumeEntry,
  loadFiles,
  MocksError,
  type RunOptions,
  type RunPlan,
  type RunResult,
  renderJUnit,
  renderMarkdownReport,
  renderMermaid,
  renderText,
  renderTextReport,
  runTests,
  type ScenarioInput,
  simulate,
} from '@simulci/engine';
import {
  AssumeError,
  discoverTests,
  diskSnapshotStore,
  misplacedTests,
  parseAssume,
  readTests,
  readWorkflowFiles,
  TESTS_DIR,
} from '@simulci/node';
import { parse } from 'yaml';

/**
 * The action, over what the runner gives it: inputs, outputs, annotations, the job summary, the log. `test` runs the
 * route tests of the checkout as `simulci test --ci` would and fails the step when they do; `plan` prints the plan
 * for a scenario and puts it in the job summary.
 */

export interface Ports {
  /** An input, trimmed; empty when not set. */
  input(name: string): string;
  setOutput(name: string, value: string | number): void;
  annotate(annotation: Annotation): void;
  summary(markdown: string): Promise<void>;
  log(text: string): void;
  /** Marks the step failed with the message; the action still finishes what it was doing. */
  fail(message: string): void;
  workspace: string;
}

const OUTPUTS = ['passed', 'failed', 'invalid', 'skipped'] as const;

export async function run(ports: Ports): Promise<void> {
  for (const name of OUTPUTS) ports.setOutput(name, 0);
  ports.setOutput('exit-code', 2);
  ports.setOutput('triggered', '');
  const mode = ports.input('mode') || 'test';
  if (mode !== 'test' && mode !== 'plan') {
    ports.fail(`mode must be test or plan, not '${mode}'`);
    return;
  }
  const dir = ports.input('working-directory') || '.';
  const root = resolve(ports.workspace, dir);
  const workflows = readWorkflowFiles(root);
  if (Object.keys(workflows).length === 0) {
    ports.fail(`no workflows under ${dir}/.github/workflows`);
    return;
  }
  let assume: AssumeEntry[];
  try {
    assume = parseAssume(lines(ports.input('assume')));
  } catch (e) {
    if (!(e instanceof AssumeError)) throw e;
    ports.fail(e.message);
    return;
  }
  const ctx: Context = { ports, root, dir, workflows, assume };
  if (mode === 'plan') await plan(ctx);
  else await test(ctx);
}

interface Context {
  ports: Ports;
  root: string;
  dir: string;
  workflows: Record<string, string>;
  assume: AssumeEntry[];
}

async function test(ctx: Context): Promise<void> {
  const { ports, root } = ctx;
  const named = lines(ports.input('files')).map((f) => resolve(root, f));
  const files = discoverTests(root, named);
  const misplaced = misplacedTests(files);
  if (misplaced.length) {
    ports.fail(
      `T000 ${misplaced.join(', ')}: a test file under .github/workflows would be run by GitHub; put it under ${TESTS_DIR}`,
    );
    return;
  }
  let result: RunResult;
  try {
    result = runTests(loadFiles(ctx.workflows), readTests(root, files), testOptions(ctx));
  } catch (e) {
    if (!(e instanceof MocksError)) throw e;
    ports.fail(e.message);
    return;
  }
  await reportTests(ctx, result);
  for (const name of OUTPUTS) ports.setOutput(name, result.summary[name]);
  ports.setOutput('exit-code', result.exitCode);
  if (result.exitCode !== 0) {
    const s = result.summary;
    ports.fail(
      `simulci test: ${s.failed} failed, ${s.invalid} invalid, ${s.passed} passed (exit ${result.exitCode})`,
    );
  }
}

/** As `simulci test --ci`: snapshots are never written, a missing one fails. */
function testOptions(ctx: Context): RunOptions {
  const options: RunOptions = {
    ci: true,
    strict: bool(ctx.ports, 'strict'),
    snapshots: diskSnapshotStore(ctx.root),
  };
  const filter = ctx.ports.input('filter');
  if (filter) options.filter = filter;
  if (ctx.assume.length) options.cli = ctx.assume;
  return options;
}

/** The log, the annotations, the job summary and the JUnit file. */
async function reportTests(ctx: Context, result: RunResult): Promise<void> {
  const { ports } = ctx;
  ports.log(renderTextReport(result));
  if (bool(ports, 'annotations', true))
    for (const a of annotationsOf(result)) ports.annotate(inWorkspace(ctx, a));
  if (bool(ports, 'summary', true)) {
    await ports.summary(renderMarkdownReport(result, { title: ports.input('title') || 'simulci test' }));
  }
  const junit = ports.input('junit');
  if (junit) writeReport(ctx, junit, renderJUnit(result));
}

async function plan(ctx: Context): Promise<void> {
  const { ports } = ctx;
  const text = ports.input('scenario');
  if (!text) {
    ports.fail('scenario is required in plan mode: a YAML mapping such as { event: push, branch: main }');
    return;
  }
  let result: RunPlan;
  try {
    const scenario = parse(text) as ScenarioInput;
    result = simulate({ files: ctx.workflows, scenario, mocks: { cli: ctx.assume } });
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    ports.fail(`scenario: ${e.message}`);
    return;
  }
  ports.log(renderPlan(result, ports.input('format') || 'text'));
  if (bool(ports, 'summary', true))
    await ports.summary(planSummary(result, ports.input('title') || 'simulci plan'));
  ports.setOutput('triggered', result.workflows.filter((w) => w.triggered.verdict !== 'no').length);
  ports.setOutput('exit-code', 0);
}

function renderPlan(result: RunPlan, format: string): string {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  return format === 'mermaid' ? renderMermaid(result) : renderText(result);
}

/** The plan as text, then the graph (GitHub renders Mermaid in job summaries). */
function planSummary(result: RunPlan, title: string): string {
  const text = renderText(result).trimEnd();
  const graph = renderMermaid(result).trimEnd();
  return [
    `## ${title}: ${result.scenario.id}`,
    '',
    '```',
    text,
    '```',
    '',
    '```mermaid',
    graph,
    '```',
    '',
  ].join('\n');
}

/** Annotation paths are relative to the repository root; the tests' are relative to working-directory. */
function inWorkspace(ctx: Context, a: Annotation): Annotation {
  if (isAbsolute(a.file)) return a;
  const file = relative(ctx.ports.workspace, resolve(ctx.root, a.file)).split(sep).join('/');
  return { ...a, file };
}

/** Writes a report under the workspace; a path that escapes it is refused. */
function writeReport(ctx: Context, path: string, content: string): void {
  const file = resolve(ctx.ports.workspace, path);
  const inside = file === ctx.ports.workspace || file.startsWith(`${ctx.ports.workspace}${sep}`);
  if (!inside) {
    ctx.ports.fail(`${path} is outside the workspace; reports are written under it`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  ctx.ports.setOutput('junit', file);
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n|\s{2,}/)
    .map((l) => l.trim())
    .filter(Boolean);

function bool(ports: Ports, name: string, fallback = false): boolean {
  const v = ports.input(name).toLowerCase();
  if (v === '') return fallback;
  return v === 'true';
}
