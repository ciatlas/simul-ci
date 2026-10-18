import type { CaseResult, Failure, FileResult, RunResult } from '@simulci/engine';

/** The three renderings of a run: text for the terminal, workflow commands for annotations, JUnit for CI systems. */

const MARK = { passed: '✓', failed: '✗', invalid: '!', skipped: '-' } as const;

export function renderTextReport(result: RunResult): string {
  const lines: string[] = [];
  for (const file of result.files) {
    lines.push(`${file.path}${file.workflow ? ` → ${file.workflow.replace(/^.*\//, '')}` : ''}`);
    for (const f of file.failures) lines.push(...failureLines(f, '  '));
    for (const note of file.notes) lines.push(`  · ${note}`);
    for (const c of file.cases) lines.push(...caseLines(c));
  }
  const s = result.summary;
  lines.push(
    '',
    `${s.passed} passed · ${s.failed} failed · ${s.invalid} invalid · ${s.skipped} skipped · exit ${result.exitCode}`,
  );
  return `${lines.join('\n')}\n`;
}

function caseLines(c: CaseResult): string[] {
  const reason = c.status === 'skipped' && c.reason ? ` (${c.reason})` : '';
  const lines = [`  ${MARK[c.status]} ${c.name}${reason}`];
  for (const f of c.failures) lines.push(...failureLines(f, '      '));
  for (const note of c.notes) lines.push(`      · ${note}`);
  return lines;
}

function failureLines(f: Failure, pad: string): string[] {
  const lines = [`${pad}${f.headline}`, ...f.detail.map((d) => `${pad}    ${d}`)];
  if (f.at.line > 0) lines.push(`${pad}  at ${f.at.line}:${f.at.col}`);
  return lines;
}

const ANNOTATION_CAP = 9;

/** `::error` on the assertion's own line, `::notice` on the workflow line that decided; at most ten per severity. */
export function renderAnnotations(result: RunResult): string[] {
  const errors: string[] = [];
  const notices: string[] = [];
  for (const file of result.files) {
    for (const f of file.failures) errors.push(annotation('error', file.path, f, `simulci: ${file.path}`));
    for (const c of file.cases) {
      for (const f of c.failures) {
        errors.push(annotation('error', file.path, f, `simulci: ${c.name}`));
        if (f.workflowLoc) {
          const loc = f.workflowLoc;
          const message = `${f.headline} (test: ${file.path}:${f.at.line})`;
          notices.push(
            `::notice file=${prop(loc.file)},line=${loc.line},col=${loc.column},title=${prop('simulci: decided here')}::${msg(message)}`,
          );
        }
      }
    }
  }
  return [...capped(errors, 'error'), ...capped(notices, 'notice')];
}

function annotation(kind: 'error', file: string, f: Failure, title: string): string {
  const body = [f.headline, ...f.detail].join('\n');
  return `::${kind} file=${prop(file)},line=${f.at.line},col=${f.at.col},title=${prop(title)}::${msg(body)}`;
}

function capped(items: string[], kind: string): string[] {
  if (items.length <= ANNOTATION_CAP + 1) return items;
  const rest = items.length - ANNOTATION_CAP;
  return [
    ...items.slice(0, ANNOTATION_CAP),
    `::${kind}::${rest} more ${kind === 'error' ? 'failures' : 'notices'} not shown; see the log`,
  ];
}

/** As actions/toolkit escapes: `%`, CR and LF in messages; also `:` and `,` in properties. */
const msg = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s: string): string => msg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function renderJUnit(result: RunResult): string {
  const suites = result.files.map(suite);
  const totals = count(
    result.files.flatMap((f) => f.cases),
    result.files,
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="simulci" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}">`,
    ...suites,
    '</testsuites>',
  ];
  return `${lines.join('\n')}\n`;
}

function suite(file: FileResult): string {
  const t = count(file.cases, [file]);
  const lines = [
    `  <testsuite name="${xml(file.path)}" tests="${t.tests}" failures="${t.failures}" errors="${t.errors}" skipped="${t.skipped}" time="0">`,
  ];
  if (file.failures.length) {
    lines.push(`    <testcase classname="${xml(file.path)}" name="(file)" time="0">`);
    for (const f of file.failures)
      lines.push(
        `      <error type="${xml(f.code ?? 'invalid')}" message="${xml(f.headline)}">${xml(body(f))}</error>`,
      );
    lines.push('    </testcase>');
  }
  for (const c of file.cases) lines.push(...testcase(file, c));
  lines.push('  </testsuite>');
  return lines.join('\n');
}

function testcase(file: FileResult, c: CaseResult): string[] {
  const open = `    <testcase classname="${xml(file.path)}" name="${xml(c.name)}" time="0">`;
  if (c.status === 'passed') return [`${open}</testcase>`];
  return [open, ...caseBody(file, c), '    </testcase>'];
}

function caseBody(file: FileResult, c: CaseResult): string[] {
  if (c.status === 'skipped') return [`      <skipped message="${xml(c.reason ?? 'skipped')}"/>`];
  if (c.status === 'invalid') return errorLines(c.failures.length ? c.failures : file.failures);
  const [first, ...rest] = c.failures;
  const message = `${first!.headline}${rest.length ? ` (+${rest.length} more)` : ''}`;
  return [
    `      <failure type="assertion" message="${xml(message)}">${xml(c.failures.map(body).join('\n\n'))}</failure>`,
  ];
}

const errorLines = (failures: Failure[]): string[] =>
  failures.map(
    (f) =>
      `      <error type="${xml(f.code ?? 'invalid')}" message="${xml(f.headline)}">${xml(body(f))}</error>`,
  );

const body = (f: Failure): string => [f.headline, ...f.detail, `at ${f.at.line}:${f.at.col}`].join('\n');

function count(
  cases: CaseResult[],
  files: FileResult[],
): { tests: number; failures: number; errors: number; skipped: number } {
  const fileErrors = files.filter((f) => f.failures.length).length;
  return {
    tests: cases.length + fileErrors,
    failures: cases.filter((c) => c.status === 'failed').length,
    errors: cases.filter((c) => c.status === 'invalid').length + fileErrors,
    skipped: cases.filter((c) => c.status === 'skipped').length,
  };
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
