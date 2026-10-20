/**
 * The edit runtime (synthesis § 4.1, § 4.10, § 9.4 rows 10, 11 and 18): ops planned on the documents of the texts now
 * and committed as one transaction that names the text it was planned against; a refusal kept with its fixes, a fix
 * and its retry one undo step; a stale revision and a step that moved refused with nothing written; the selection an
 * op leaves applied by the plan of its texts and no older one; the documents cached by revision.
 */
import { WorkflowDocument } from '@simulci/document';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFix, dispatch } from '../src/edit/dispatch';
import { createDocuments, documents } from '../src/edit/documents';
import { targetOf } from '../src/edit/selection';
import type { FileMeta } from '../src/input/read';
import { createSessionStore, type PlanState, type SessionStore } from '../src/state/store';
import type { Outline } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';
const LOCK = '.github/workflows/ci.lock.yml';
const FOLDER = { kind: 'folder', name: 'repo', readAt: 0 } as const;

const TEXT = `on: push
jobs:
  build:
    runs-on: &runner ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  deploy:
    needs: build
    runs-on: *runner
    if: github.ref == 'refs/heads/main'
    steps:
      - run: ./deploy
`;

const OUTLINE: Outline = { files: [], workflows: [], events: {} };

/** A store showing a plan of the files, with the Outline that says which are generated. */
function opened(
  byPath: Record<string, string> = { [CI]: TEXT },
  options: { generated?: Record<string, string>; meta?: Record<string, FileMeta> } = {},
): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  s.setFiles(byPath, FOLDER, options.meta);
  const { version, epoch } = store.getState().files;
  const files = Object.keys(byPath).map((path) => {
    const file: Outline['files'][number] = { path, kind: 'workflow', errors: [] };
    const marker = options.generated?.[path];
    if (marker !== undefined) file.generated = marker;
    return file;
  });
  s.projectReady(1, { ...OUTLINE, files }, version);
  s.planReceived(planFor(version, epoch));
  return store;
}

const planFor = (files: number, epoch: number): PlanState =>
  ({ for: { files, epoch, project: 1 } }) as PlanState;

const text = (store: SessionStore, path = CI): string => store.getState().files.byPath[path]!;

afterEach(() => vi.restoreAllMocks());

describe('dispatch', () => {
  it('commits an op as one entry, labelled as the op, and leaves the plan and the selection where they were', () => {
    const store = opened();
    store.getState().select(CI, 'deploy');
    const plan = store.getState().plan;
    const result = dispatch(store, {
      op: 'setJobField',
      file: CI,
      job: 'deploy',
      field: 'if',
      value: 'false',
    });
    expect(result).toMatchObject({ ok: true, changed: true, label: "Set deploy's if" });
    const s = store.getState();
    // The writer keeps the value a string, as the field gave it: `false` alone would read as a boolean.
    expect(text(store)).toBe(TEXT.replace("if: github.ref == 'refs/heads/main'", "if: 'false'"));
    expect(s.edit.past).toHaveLength(1);
    expect(s.edit.past[0]).toMatchObject({ label: "Set deploy's if", origin: 'op' });
    expect([s.plan, s.focus, s.sel, s.stale]).toEqual([plan, CI, 'deploy', 'edit']);
    // The op selects what it edited, which is what was selected: nothing waits for the plan.
    expect(s.edit.pendingSel).toBeUndefined();
  });

  it('plans each op of a gesture on the text the one before wrote, and commits them as one entry', () => {
    const store = opened();
    const result = dispatch(store, [
      { op: 'addJob', file: CI, id: 'lint', after: 'build', job: { 'runs-on': 'ubuntu-latest' } },
      { op: 'setJobField', file: CI, job: 'lint', field: 'if', value: "github.event_name == 'push'" },
    ]);
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(store.getState().edit.past).toHaveLength(1);
    expect(text(store)).toContain(
      "  lint:\n    runs-on: ubuntu-latest\n    if: github.event_name == 'push'\n",
    );
    store.getState().undo();
    expect(text(store)).toBe(TEXT);
  });

  it('leaves the selection an op makes waiting for the plan of its texts, and no older plan applies it', () => {
    const store = opened();
    store.getState().select(CI, 'build');
    const before = store.getState().files;
    dispatch(store, { op: 'addJob', file: CI, id: 'lint', after: 'build', job: {} });
    const { version, epoch } = store.getState().files;
    expect(store.getState().edit.pendingSel).toEqual({ focus: CI, sel: 'lint', files: version });
    // A plan of the texts before the op, answered late: its `lint` would not be the new job.
    store.getState().planReceived(planFor(before.version, epoch));
    expect([store.getState().sel, store.getState().edit.pendingSel?.sel]).toEqual(['build', 'lint']);
    store.getState().planReceived(planFor(version, epoch));
    expect(store.getState().sel).toBe('lint');
    expect(store.getState().edit.pendingSel).toBeUndefined();
  });

  it('gives way to a selection the author makes before the plan comes', () => {
    const store = opened();
    dispatch(store, { op: 'addJob', file: CI, id: 'lint', job: {} });
    store.getState().select(CI, 'deploy');
    store.getState().planReceived(planFor(store.getState().files.version, store.getState().files.epoch));
    expect(store.getState().sel).toBe('deploy');
  });

  it('restores the selection an undone entry was made under, once the plan of the texts it leaves is in', () => {
    const store = opened();
    store.getState().select(CI, 'build');
    dispatch(store, { op: 'addJob', file: CI, id: 'lint', after: 'build', job: {} });
    const { epoch } = store.getState().files;
    store.getState().planReceived(planFor(store.getState().files.version, epoch));
    expect(store.getState().sel).toBe('lint');
    store.getState().undo();
    expect(store.getState().edit.pendingSel).toEqual({
      focus: CI,
      sel: 'build',
      files: store.getState().files.version,
    });
    store.getState().planReceived(planFor(store.getState().files.version, epoch));
    expect(store.getState().sel).toBe('build');
    store.getState().redo();
    store.getState().planReceived(planFor(store.getState().files.version, epoch));
    expect(store.getState().sel).toBe('lint');
  });

  it('does not push an op that changes nothing', () => {
    const store = opened();
    const result = dispatch(store, { op: 'setJobField', file: CI, job: 'build', field: 'if', value: null });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(store.getState().edit.past).toHaveLength(0);
    expect(store.getState().files.version).toBe(1);
  });

  it('refuses an op on a text that moved since the gesture read it, and writes nothing', () => {
    const store = opened();
    const target = targetOf(store, CI, 'deploy')!;
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '# ci\n' }]);
    const result = dispatch(
      store,
      { op: 'setJobField', file: CI, job: 'deploy', field: 'if', value: 'false' },
      { revs: { [CI]: target.rev } },
    );
    expect(result).toMatchObject({ ok: false, refused: { refusal: { reason: 'stale', file: CI } } });
    expect(text(store)).toBe(`# ci\n${TEXT}`);
    expect(store.getState().edit.refused?.refusal.message).toBe(
      'ci.yml changed since this edit began; try again.',
    );
  });

  it('refuses a step op whose step is not the one the author saw (moved), and writes nothing', () => {
    const store = opened();
    // The author picked build's second step, `npm test`; a step typed in above it since takes its index.
    const target = targetOf(store, CI, 'build.#2')!;
    expect(target).toMatchObject({
      path: ['jobs', 'build', 'steps', 1],
      step: { index: 1, fp: { runHead: 'npm test' } },
    });
    const at = TEXT.indexOf('      - run: npm test');
    store.getState().typed(CI, [{ from: at, to: at, insert: '      - run: npm ci\n' }]);
    const typed = text(store);
    const result = dispatch(store, {
      op: 'setStepField',
      file: CI,
      job: 'build',
      index: target.step!.index,
      fp: target.step!.fp,
      field: 'name',
      value: 'Test',
    });
    expect(result).toMatchObject({ ok: false, refused: { refusal: { reason: 'moved' } } });
    expect(text(store)).toBe(typed);
  });

  it('keeps a refusal with its fixes, and a fix with the retried op is one undo step', () => {
    const store = opened();
    const result = dispatch(store, {
      op: 'setJobField',
      file: CI,
      job: 'deploy',
      field: 'runs-on',
      value: 'macos-latest',
    });
    if (result.ok) throw new Error('an aliased runs-on was written in place');
    const { refusal } = result.refused;
    expect(refusal.reason).toBe('alias');
    expect(store.getState().edit.refused).toEqual(result.refused);
    const own = refusal.fixes.find((f) => f.label === "Give deploy's `runs-on` its own value")!;
    expect(own).toMatchObject({ kind: 'ops', retry: true });
    expect(applyFix(store, result.refused, own)).toMatchObject({ ok: true, changed: true });
    expect(text(store)).toContain('  deploy:\n    needs: build\n    runs-on: macos-latest\n');
    expect(text(store)).toContain('    runs-on: &runner ubuntu-latest\n');
    expect(store.getState().edit.past).toHaveLength(1);
    expect(store.getState().edit.refused).toBeUndefined();
    store.getState().undo();
    expect(text(store)).toBe(TEXT);
  });

  it('changes every use of a shared anchor in one entry when the author picks “Change all”', () => {
    const store = opened();
    const result = dispatch(store, {
      op: 'setJobField',
      file: CI,
      job: 'build',
      field: 'runs-on',
      value: 'macos-latest',
    });
    if (result.ok) throw new Error('a shared anchor was written in place');
    expect(result.refused.refusal.reason).toBe('shared-anchor');
    const all = result.refused.refusal.fixes.find((f) => f.kind === 'shared-all')!;
    expect(applyFix(store, result.refused, all)).toMatchObject({ ok: true, changed: true });
    expect(text(store)).toContain('runs-on: &runner macos-latest');
    expect(text(store)).toContain('runs-on: *runner');
    expect(store.getState().edit.past).toHaveLength(1);
  });

  it('refuses a fix once the text moved since the refusal: its lines are the old text’s', () => {
    const store = opened();
    const result = dispatch(store, {
      op: 'setJobField',
      file: CI,
      job: 'deploy',
      field: 'runs-on',
      value: 'x',
    });
    if (result.ok) throw new Error('refused expected');
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '# ci\n' }]);
    expect(applyFix(store, result.refused, result.refused.refusal.fixes[0]!)).toMatchObject({
      ok: false,
      refused: { refusal: { reason: 'stale' } },
    });
    expect(store.getState().edit.past).toHaveLength(1);
  });

  it('runs the fixes that act on the page: Edit in YAML reveals the line in edit mode, Undo undoes', () => {
    const store = opened();
    const result = dispatch(store, {
      op: 'setJobField',
      file: CI,
      job: 'deploy',
      field: 'runs-on',
      value: 'x',
    });
    if (result.ok) throw new Error('refused expected');
    const anchor = result.refused.refusal.fixes.find((f) => f.kind === 'reveal')!;
    expect(applyFix(store, result.refused, anchor)).toBeUndefined();
    expect(store.getState()).toMatchObject({ edit: { on: true }, reveal: { file: CI, line: 4 } });
    expect(store.getState().edit.refused).toBeUndefined();
  });

  it('refuses a generated file until the author unlocks it, then makes the edit', () => {
    const store = opened({ [LOCK]: TEXT }, { generated: { [LOCK]: 'DO NOT EDIT' } });
    const result = dispatch(store, {
      op: 'setJobField',
      file: LOCK,
      job: 'deploy',
      field: 'if',
      value: 'false',
    });
    if (result.ok) throw new Error('a generated file was edited');
    expect(result.refused.refusal.reason).toBe('generated');
    const unlock = result.refused.refusal.fixes.find((f) => f.kind === 'unlock')!;
    expect(applyFix(store, result.refused, unlock)).toMatchObject({ ok: true, changed: true });
    expect(store.getState().edit.unlocked).toEqual([LOCK]);
    expect(text(store, LOCK)).toContain("if: 'false'");
  });

  it('refuses a file that is not UTF-8, and one too large to parse on the main thread, before planning', () => {
    const meta = { [CI]: { bom: false, eol: 'lf', utf8: false } as const };
    const store = opened({ [CI]: TEXT }, { meta });
    expect(dispatch(store, { op: 'removeJob', file: CI, job: 'deploy' })).toMatchObject({
      ok: false,
      refused: { refusal: { reason: 'not-utf8' } },
    });
    const huge = `${TEXT}${'# filler line of a very large workflow file\n'.repeat(13_000)}`;
    const big = opened({ [CI]: huge });
    const started = performance.now();
    expect(dispatch(big, { op: 'removeJob', file: CI, job: 'deploy' })).toMatchObject({
      ok: false,
      refused: { refusal: { reason: 'too-large' } },
    });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('answers a dismissed refusal with nothing, and the next commit clears one', () => {
    const store = opened();
    dispatch(store, { op: 'removeJob', file: CI, job: 'nope' });
    expect(store.getState().edit.refused?.refusal.reason).toBe('not-found');
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#\n' }]);
    expect(store.getState().edit.refused).toBeUndefined();
  });
});

describe('the documents', () => {
  it('parse a text once per revision, and an op’s document stands for the text it wrote', () => {
    const store = opened();
    const open = vi.spyOn(WorkflowDocument, 'open');
    const docs = documents(store);
    const doc = docs.of(store.getState(), CI)!;
    expect(docs.of(store.getState(), CI)).toBe(doc);
    expect(open).toHaveBeenCalledTimes(1);
    dispatch(store, { op: 'setJobField', file: CI, job: 'deploy', field: 'if', value: 'false' });
    const calls = open.mock.calls.length;
    const after = docs.of(store.getState(), CI)!;
    expect(open).toHaveBeenCalledTimes(calls);
    expect(after.text).toBe(text(store));
  });

  it('never serve a document of another text, whatever was put in for the revision', () => {
    const store = opened();
    const docs = createDocuments();
    const s = store.getState();
    const other = WorkflowDocument.open('on: pull_request\n', { path: CI, kind: 'workflow' });
    docs.seed(s, CI, other, {});
    expect(docs.of(s, CI)!.text).toBe(TEXT);
    // A seed is kept only when it is the file's text.
    const seeded = WorkflowDocument.open(TEXT, { path: CI, kind: 'workflow' });
    docs.seed(s, CI, seeded, {});
    expect(docs.of(s, CI)).toBe(seeded);
  });

  it('open a generated file locked until the author unlocks it or has edited it', () => {
    const store = opened({ [LOCK]: TEXT }, { generated: { [LOCK]: 'DO NOT EDIT' } });
    const docs = documents(store);
    expect(docs.of(store.getState(), LOCK)!.status.editable).toBe(false);
    store.getState().unlock(LOCK);
    expect(docs.of(store.getState(), LOCK)!.status.editable).toBe(true);
  });
});

describe('targets', () => {
  it('map the selection through the document of the text now: a job, a step, a leg as its job, the workflow', () => {
    const store = opened();
    expect(targetOf(store, CI, undefined)).toEqual({ file: CI, rev: 1, path: [] });
    expect(targetOf(store, CI, 'deploy')).toEqual({
      file: CI,
      rev: 1,
      path: ['jobs', 'deploy'],
      job: 'deploy',
    });
    expect(targetOf(store, CI, 'deploy[os=a]')).toMatchObject({ path: ['jobs', 'deploy'] });
    expect(targetOf(store, CI, 'build.#1')).toMatchObject({
      path: ['jobs', 'build', 'steps', 0],
      step: { index: 0, fp: { uses: 'actions/checkout@v4' } },
    });
    // A called workflow's job is not in this file; a unit path the text lost names nothing.
    expect(targetOf(store, CI, 'deploy/inner')).toBeUndefined();
    expect(targetOf(store, CI, 'gone')).toBeUndefined();
    expect(targetOf(store, '.github/workflows/none.yml', undefined)).toBeUndefined();
  });
});
