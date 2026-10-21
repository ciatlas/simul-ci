// @vitest-environment happy-dom
/**
 * The canvas's structural gestures (synthesis § 4.2, § 4.5, resolved contradiction 30): which drags may connect two
 * cards (not the same job, not another workflow's, not a need it has, not a loop by the document's needs), a need
 * written in the file's style and drawn dashed until its picture comes, a loop refused with its sentence and nothing
 * written, a removal that takes needs with it asked about first and left with an Undo notice, Add job's op and what it
 * offers, and a key pressed before the edit runtime is in kept until it is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addJob,
  addJobOp,
  canConnect,
  checkoutOf,
  connect,
  disconnect,
  gesturesOf,
  idProblem,
  offeredId,
  removedJobText,
  runsOnFor,
} from '../src/edit/canvas/actions';
import type { Ask, GestureUi, Open } from '../src/edit/canvas/ui';
import { documents } from '../src/edit/documents';
import { gestures, pendingEdges } from '../src/edit/gestures';
import { createSessionStore, type SessionStore } from '../src/state/store';
import type { Outline } from '../src/worker/protocol';
import { handle, initialState } from '../src/worker/handle';

const CI = '.github/workflows/ci.yml';
const OTHER = '.github/workflows/other.yml';

const TEXT = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  build:
    needs:
      - test
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v5
      - run: npm run build
  deploy:
    needs: [test, build]
    if: needs.build.outputs.ok == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;

const OTHER_TEXT = `on: push
jobs:
  other:
    runs-on: ubuntu-latest
    steps:
      - run: echo
`;

const node = (job: string, file = CI): string => `${file}#${job}`;

/** A store showing the plan of the files under push to main, in edit mode on the CI workflow. */
function opened(files: Record<string, string> = { [CI]: TEXT, [OTHER]: OTHER_TEXT }): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  s.setFiles(files, { kind: 'folder', name: 'repo', readAt: 0 });
  const loaded = handle(initialState(), { id: 1, type: 'load', files });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  s.projectReady(1, loaded.response.outline, 1);
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario: { event: 'push', branch: 'main' },
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  const { plan, derived, text, ms } = step.response;
  s.planReceived({ plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1 } });
  s.setEdit(true);
  s.select(CI, undefined);
  return store;
}

/** A host that records what the gestures ask it to show. */
function fakeUi() {
  const shown: { open: Open[]; asks: Ask[]; refused: number[]; added: string[] } = {
    open: [],
    asks: [],
    refused: [],
    added: [],
  };
  const ui: GestureUi = {
    open: (o) => shown.open.push(o),
    confirm: (a) => shown.asks.push(a),
    refused: (seq) => shown.refused.push(seq),
    added: (card) => shown.added.push(card),
  };
  return { ui, shown };
}

const text = (store: SessionStore): string => store.getState().files.byPath[CI]!;

afterEach(() => vi.restoreAllMocks());

describe('connecting two cards', () => {
  it('lets a drag end on another job of the workflow being edited that does not need it yet and would not loop', () => {
    const store = opened();
    expect(canConnect(store, node('lint'), node('deploy'))).toBe(true);
    expect(canConnect(store, node('test'), node('lint'))).toBe(true);
    // The same job, a need it has, a loop by the text's needs, another workflow's job.
    expect(canConnect(store, node('lint'), node('lint'))).toBe(false);
    expect(canConnect(store, node('build'), node('deploy'))).toBe(false);
    expect(canConnect(store, node('deploy'), node('test'))).toBe(false);
    expect(canConnect(store, node('other', OTHER), node('lint'))).toBe(false);
    // Outside edit mode nothing connects.
    store.getState().setEdit(false);
    expect(canConnect(store, node('lint'), node('deploy'))).toBe(false);
  });

  it('reads the needs from the text now, not from the plan, which lags the pane', () => {
    const store = opened();
    expect(canConnect(store, node('lint'), node('test'))).toBe(true);
    // Typed in the pane: lint now needs deploy, which needs test. The plan has not caught up; test needing lint
    // would loop all the same, and lint needs deploy already.
    const at = text(store).indexOf('  lint:\n') + '  lint:\n'.length;
    store.getState().typed(CI, [{ from: at, to: at, insert: '    needs: deploy\n' }]);
    expect(canConnect(store, node('lint'), node('test'))).toBe(false);
    expect(canConnect(store, node('deploy'), node('lint'))).toBe(false);
    expect(canConnect(store, node('test'), node('lint'))).toBe(true);
  });

  it('writes the need in the file’s style, labels it for the status line and draws it dashed until its picture', () => {
    const store = opened();
    const { ui } = fakeUi();
    connect(store, ui, node('lint'), node('build'));
    expect(text(store)).toContain('    needs:\n      - test\n      - lint\n');
    connect(store, ui, node('lint'), node('deploy'));
    expect(text(store)).toContain('    needs: [test, build, lint]\n');
    expect(store.getState().edit.past.map((t) => t.label)).toEqual([
      'Connected lint to build',
      'Connected lint to deploy',
    ]);
    const version = store.getState().files.version;
    expect(pendingEdges.of(store)).toEqual([
      { source: node('lint'), target: node('build'), files: version - 1 },
      { source: node('lint'), target: node('deploy'), files: version },
    ]);
    pendingEdges.settle(store, version - 1);
    expect(pendingEdges.of(store)).toHaveLength(1);
    pendingEdges.settle(store, version);
    expect(pendingEdges.of(store)).toEqual([]);
    // Undoing both gives the bytes back.
    store.getState().undo();
    store.getState().undo();
    expect(text(store)).toBe(TEXT);
  });

  it('refuses a drop that would loop with the document’s sentence, writing nothing', () => {
    const store = opened();
    const { ui, shown } = fakeUi();
    connect(store, ui, node('deploy'), node('test'));
    expect(text(store)).toBe(TEXT);
    expect(store.getState().edit.refused?.refusal).toMatchObject({
      reason: 'cycle',
      message: 'deploy already needs test; test needing deploy would loop.',
    });
    expect(shown.refused).toEqual([store.getState().edit.refused!.seq]);
    // A need it has already writes nothing and says nothing.
    store.getState().refused(undefined);
    connect(store, ui, node('test'), node('build'));
    expect(text(store)).toBe(TEXT);
    expect(store.getState().edit.refused).toBeUndefined();
  });

  it('removes the need an edge draws, asking first when an expression still reads it, with Undo in the notice', () => {
    const store = opened();
    const { ui, shown } = fakeUi();
    disconnect(store, ui, node('test'), node('build'));
    expect(text(store)).not.toContain('    needs:\n      - test\n');
    expect(store.getState().notices.at(-1)).toMatchObject({ text: "Removed build's need on test" });
    expect(store.getState().notices.at(-1)!.undo).toBe(store.getState().edit.past.at(-1));
    // deploy reads needs.build: asked first, nothing written until the answer.
    const before = text(store);
    disconnect(store, ui, node('build'), node('deploy'));
    expect(text(store)).toBe(before);
    expect(shown.asks).toHaveLength(1);
    expect(shown.asks[0]).toMatchObject({
      title: "Remove deploy's need on build?",
      action: 'Remove the need',
    });
    expect(shown.asks[0]!.lines[0]).toMatch(/still reads needs\.build/);
    shown.asks[0]!.run();
    expect(text(store)).toContain('    needs: [test]\n');
  });
});

describe('removing a job', () => {
  it('asks first when jobs need it, then takes their needs with it, with Undo in the notice', () => {
    const store = opened();
    store.getState().select(CI, 'test');
    const { ui, shown } = fakeUi();
    expect(gesturesOf(store, ui).remove()).toBe(true);
    expect(text(store)).toBe(TEXT);
    expect(shown.asks[0]).toMatchObject({
      title: 'Remove job test?',
      action: 'Remove test',
      lines: ['build and deploy need it: their needs on test go too.'],
    });
    shown.asks[0]!.run();
    expect(text(store)).not.toMatch(/\btest:/);
    expect(text(store)).toContain('    needs: [build]\n');
    expect(text(store)).not.toContain('    needs:\n      - test');
    expect(store.getState().notices.at(-1)?.text).toBe("Removed test and build's and deploy's needs on it");
    expect(store.getState().edit.past.at(-1)?.label).toBe('Removed job test');
    store.getState().undo();
    expect(text(store)).toBe(TEXT);
  });

  it('removes a job nothing needs at once, and leaves a leg, the workflow and a called job alone', () => {
    const store = opened();
    const { ui, shown } = fakeUi();
    store.getState().select(CI, 'lint');
    expect(gesturesOf(store, ui).remove()).toBe(true);
    expect(shown.asks).toEqual([]);
    expect(text(store)).not.toContain('lint');
    expect(store.getState().notices.at(-1)?.text).toBe('Removed lint');
    for (const sel of [undefined, 'build[os=linux]', 'call/inner'] as const) {
      store.getState().select(CI, sel);
      expect(gesturesOf(store, ui).remove()).toBe(false);
    }
  });

  it('words what goes with it', () => {
    expect(removedJobText('lint', [])).toBe('Removed lint');
    expect(removedJobText('lint', ['deploy'])).toBe("Removed lint and deploy's need on it");
    expect(removedJobText('lint', ['a', 'b', 'c'])).toBe("Removed lint and a's, b's and c's needs on it");
  });
});

describe('adding a job', () => {
  it('opens Add job after the selected job, a leg’s or a step’s, else for the workflow', () => {
    const store = opened();
    const { ui, shown } = fakeUi();
    const g = gesturesOf(store, ui);
    store.getState().select(CI, 'build');
    expect(g.addJob()).toBe(true);
    store.getState().select(CI, 'build.#2');
    expect(g.addJob()).toBe(true);
    store.getState().select(CI, undefined);
    expect(g.addJob()).toBe(true);
    expect(g.addJob('test')).toBe(true);
    expect(shown.open.map((o) => (o.kind === 'addJob' ? (o.after ?? '-') : o.kind))).toEqual([
      'build',
      'build',
      '-',
      'test',
    ]);
  });

  it('writes its id, runner, needs and first step after the job it follows, and selects it once its plan comes', () => {
    const store = opened();
    const { ui, shown } = fakeUi();
    const rev = store.getState().files.revs[CI]!;
    const form = {
      id: 'e2e',
      after: 'build',
      runsOn: 'ubuntu-22.04',
      needs: ['build'],
      checkout: 'actions/checkout@v5',
    };
    const result = addJob(store, ui, { file: CI, rev }, form);
    expect(result.ok).toBe(true);
    expect(text(store)).toContain(
      '      - run: npm run build\n  e2e:\n    runs-on: ubuntu-22.04\n    needs: [build]\n    steps:\n      - uses: actions/checkout@v5\n  deploy:',
    );
    expect(store.getState().edit.past.at(-1)?.label).toBe('Added job e2e after build');
    expect(store.getState().edit.pendingSel).toMatchObject({ focus: CI, sel: 'e2e' });
    expect(shown.added).toEqual([node('e2e')]);
  });

  it('writes a list of runners and no steps when asked for none', () => {
    expect(addJobOp(CI, { id: 'x', runsOn: 'self-hosted, linux', needs: [] })).toEqual({
      op: 'addJob',
      file: CI,
      id: 'x',
      job: { 'runs-on': ['self-hosted', 'linux'] },
    });
  });

  it('offers a free id, the runner of the job it follows, and checkout as the repository writes it', () => {
    const store = opened();
    const doc = documents(store).of(store.getState(), CI)!;
    expect(offeredId(doc)).toBe('job');
    expect(runsOnFor(doc, 'build')).toBe('ubuntu-22.04');
    expect(runsOnFor(doc, undefined)).toBe('ubuntu-latest');
    expect(idProblem('build', ['build'])).toMatch(/already exists/);
    expect(idProblem('BUILD', ['build'])).toMatch(/already exists/);
    expect(idProblem('2fast', [])).toMatch(/start with a letter/);
    expect(idProblem('lint-2', ['lint'])).toBeUndefined();
    const outline = {
      workflows: [{ jobs: [{ steps: [{ uses: 'actions/checkout@v4' }] }] }],
    } as unknown as Outline;
    expect(checkoutOf(outline)).toBe('actions/checkout@v4');
    expect(checkoutOf(undefined)).toBeUndefined();
    // The repository's ref wins over the catalog's.
    const catalog = [
      {
        uses: 'actions/checkout',
        ref: 'v7',
        sha: 'a'.repeat(40),
        name: 'Checkout',
        inputs: [],
        outputs: [],
        license: 'MIT',
      },
    ];
    expect(checkoutOf(undefined, catalog)).toBe('actions/checkout@v7');
    expect(checkoutOf(outline, catalog)).toBe('actions/checkout@v4');
  });
});

describe('the gestures registry', () => {
  it('keeps a key pressed before the edit runtime is in, and runs it once it registers', () => {
    const store = createSessionStore();
    const addJobCalls: (string | undefined)[] = [];
    expect(gestures.ask(store, (g) => g.addJob('build'))).toBe(true);
    const impl = { addJob: (after?: string) => addJobCalls.push(after) > 0 } as never;
    const unregister = gestures.register(store, impl);
    expect(addJobCalls).toEqual(['build']);
    expect(gestures.ask(store, (g) => g.addJob())).toBe(true);
    expect(addJobCalls).toEqual(['build', undefined]);
    unregister();
    expect(gestures.of(store)).toBeUndefined();
  });
});
