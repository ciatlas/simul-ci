// @vitest-environment happy-dom
import type { AssumeEntry, RunPlan } from '@simulci/engine';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { placeOf, type ProblemRow, problemRows } from '../src/panels/problem-rows';
import { Problems } from '../src/panels/Problems';
import { createSessionStore, initialSessionState, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';
import type { Outline } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';
const BROKEN = '.github/workflows/broken.yml';
const INDENT = '.github/workflows/indent.yml';
const NOTES = '.github/workflows/notes.yml';

/**
 * A repository with one of each problem: a tab for indentation, a key out of line, a YAML file in the workflows
 * folder that is no workflow, and a job calling a reusable workflow that is not loaded (an `unsupported` warning).
 */
const files = {
  [CI]: `on: push
jobs:
  deploy:
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  call:
    uses: o/r/.github/workflows/shared.yml@v1
`,
  [BROKEN]: 'on: push\njobs:\n  a:\n\truns-on: ubuntu-latest\n',
  [INDENT]: 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n   steps: []\n',
  [NOTES]: 'title: notes\nitems: [1, 2]\n',
};

/** The outline and a plan of a repository, as the worker answers them. */
function answered(
  repo: Record<string, string>,
  assume: AssumeEntry[] = [],
): { outline: Outline; state: PlanState } {
  const loaded = handle(initialState(), { id: 1, type: 'load', files: repo, repository: 'o/r' });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario: { event: 'push', branch: 'main' },
    assume,
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  const { plan, derived, text, ms } = step.response;
  return {
    outline: loaded.response.outline,
    state: { plan, derived, text, ms, for: { files: 1, project: 1 } },
  };
}

// An entry that matches nothing: SC102 names it, and it shows on the entry in the Unknowns tab, not here.
const { outline, state } = answered(files, [{ step: 'nope.x', outcome: 'failure' }]);
const { plan } = state;

const brief = (rows: ProblemRow[]) => rows.map((r) => [r.severity, r.code, r.file, r.line, r.column]);

describe('problemRows', () => {
  const rows = problemRows(outline, plan);

  it('lists the read errors with their line and column, then what is no workflow, then the plan’s warnings', () => {
    expect(brief(rows)).toEqual([
      ['error', 'parse', BROKEN, 4, 1],
      ['error', 'parse', INDENT, 5, 1],
      ['error', 'parse', NOTES, 1, 1],
      ['error', 'parse', NOTES, 1, 1],
      ['error', 'parse', NOTES, 1, 1],
      ['error', 'parse', NOTES, 2, 1],
      ['warning', 'unsupported', CI, 7, 3],
      ['warning', 'workflow', NOTES, 1, undefined],
    ]);
    expect(rows[0]!.message).toBe('Tabs are not allowed as indentation');
    expect(rows.find((r) => r.code === 'workflow')!.message).toBe(
      'notes.yml is not a workflow (no on: and no jobs:)',
    );
  });

  it('gives a diagnostic its node, and the line its node is declared on when it has no loc of its own', () => {
    const call = rows.find((r) => r.code === 'unsupported')!;
    expect(call.node).toBe(`${CI}#call`);
    expect(call.message).toContain('o/r/.github/workflows/shared.yml@v1');
    expect(rows.filter((r) => r.node !== undefined)).toEqual([call]);
  });

  it('leaves out an assumption’s diagnostics and the parse warnings the outline already has', () => {
    expect(plan.diagnostics.some((d) => d.code === 'SC102' && d.mock === 'assume[0]')).toBe(true);
    expect(plan.diagnostics.filter((d) => d.code === 'parse').length).toBeGreaterThan(0);
    expect(rows.some((r) => r.code.startsWith('SC'))).toBe(false);
    expect(rows.filter((r) => r.code === 'parse').every((r) => r.severity === 'error')).toBe(true);
  });

  it('keeps the plan’s parse warnings, with their node, when no outline lists the file’s errors', () => {
    const parse = problemRows(undefined, plan).filter((r) => r.code === 'parse');
    expect(parse.map((r) => [r.severity, r.file, r.node])).toEqual([
      ['warning', BROKEN, BROKEN],
      ['warning', INDENT, INDENT],
      ['warning', NOTES, NOTES],
      ['warning', NOTES, NOTES],
      ['warning', NOTES, NOTES],
      ['warning', NOTES, NOTES],
    ]);
  });

  it('lists nothing for a sound repository, or before anything is loaded', () => {
    const sound = answered({ [CI]: files[CI].replace(/ {2}call:\n.*\n$/, '') });
    expect(problemRows(sound.outline, sound.state.plan)).toEqual([]);
    expect(problemRows(undefined, undefined)).toEqual([]);
  });

  it('orders by severity, then file (none last), then line and column', () => {
    const extra: RunPlan = {
      ...plan,
      diagnostics: [
        { severity: 'info', code: 'note', message: 'about the plan' },
        { severity: 'warning', code: 'x', message: 'nowhere' },
        { severity: 'warning', code: 'y', message: 'later', loc: { file: CI, line: 9, column: 2 } },
        { severity: 'warning', code: 'z', message: 'earlier', loc: { file: CI, line: 9, column: 1 } },
        { severity: 'warning', code: 'w', message: 'gone', node: 'gone.yml#x' },
      ],
    };
    expect(brief(problemRows(undefined, extra))).toEqual([
      ['warning', 'z', CI, 9, 1],
      ['warning', 'y', CI, 9, 2],
      ['warning', 'x', undefined, undefined, undefined],
      ['warning', 'w', undefined, undefined, undefined],
      ['info', 'note', undefined, undefined, undefined],
    ]);
  });

  it('words a row’s place as its link reads', () => {
    expect(placeOf({ severity: 'error', code: 'parse', message: '', file: BROKEN, line: 4, column: 1 })).toBe(
      'broken.yml:4:1',
    );
    expect(placeOf({ severity: 'warning', code: 'workflow', message: '', file: NOTES, line: 1 })).toBe(
      'notes.yml:1',
    );
    expect(placeOf({ severity: 'info', code: 'x', message: '' })).toBeUndefined();
  });
});

describe('the Problems tab', () => {
  afterEach(cleanup);

  function mount(withPlan: boolean) {
    const initial = initialSessionState();
    const store = createSessionStore({
      ...initial,
      project: { ...initial.project, outline: withPlan ? outline : undefined },
      ...(withPlan ? { plan: state, focus: CI } : {}),
    });
    render(
      createElement(AppProvider, { app: { store } as unknown as App, children: createElement(Problems) }),
    );
    return { store, user: userEvent.setup() };
  }

  it('shows each row with its severity in words, its code, a link to its line and its node', async () => {
    const { store, user } = mount(true);
    const items = within(screen.getByRole('list', { name: 'Problems' })).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items[0]!.textContent).toContain('error');
    expect(items[0]!.textContent).toContain('Tabs are not allowed as indentation');
    await user.click(
      screen.getByRole('button', { name: new RegExp(`in the YAML pane \\(${BROKEN} line 4\\)$`) }),
    );
    expect(store.getState().reveal).toMatchObject({ file: BROKEN, line: 4 });
    await user.click(screen.getByRole('button', { name: 'Select call' }));
    expect([store.getState().focus, store.getState().sel]).toEqual([CI, 'call']);
  });

  it('says so when there is nothing to report', () => {
    mount(false);
    expect(
      screen.getByText('No problems: every file was read and the plan has no diagnostics.'),
    ).toBeTruthy();
  });
});
