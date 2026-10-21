/**
 * The adversarial review of renames (synthesis § 9.5; PR #76): each finding the reviewers reproduced, as the case it
 * failed on. No text was ever written wrong on the popover's path; what was wrong sat beside the text (the assume
 * entries, the change's map, notices, a stored refusal), in fixes that would have run on stale references, and in what
 * the lookup said.
 */
import { type Fix, fingerprint } from '@simulci/document';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFix, dispatch } from '../src/edit/dispatch';
import { documents } from '../src/edit/documents';
import { dispatchRename, findRefs, type RenameTarget } from '../src/edit/rename/run';
import { targetOf } from '../src/edit/selection';
import { planIndex, resolveSelection } from '../src/plan/index';
import { revertOf } from '../src/state/changes';
import type { SessionStore } from '../src/state/store';
import { CI, disposeSessions, jobTarget, opened, planned, results, text } from './rename-harness';

const DEPLOY = '.github/workflows/deploy.yml';
const WF =
  'on: push\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: a }]\n  test:\n    needs: build\n    runs-on: x\n    steps: [{ run: b }]\n';

afterEach(() => {
  disposeSessions();
  vi.restoreAllMocks();
});

const rename = async (
  store: SessionStore,
  session: Awaited<ReturnType<typeof opened>>['session'],
  to = 'compile',
) =>
  expect(await dispatchRename({ store, session }, jobTarget(store, CI, 'build'), to)).toMatchObject({
    ok: true,
  });

describe('the assume entries beside a rename', () => {
  it('map back on an undo that closes typing which changed nothing', async () => {
    const { store, session } = await opened({ [CI]: WF });
    store.getState().setAssume([{ job: 'build', outcome: 'failure' }]);
    await planned(store);
    await rename(store, session);
    await planned(store);
    const end = text(store).length;
    store.getState().typed(CI, [{ from: end, to: end, insert: '#' }]);
    store.getState().typed(CI, [{ from: end, to: end + 1, insert: '' }]);
    expect(store.getState().undo()).toBe(true);
    expect(text(store)).toBe(WF);
    await planned(store);
    const s = store.getState();
    expect(s.assume).toEqual([{ job: 'build', outcome: 'failure' }]);
    expect(s.change?.renames).toEqual({ [`${CI}#compile`]: `${CI}#build` });
    expect(results(store)['ci.yml:build']).toBe('failure');
  });

  it('cover no more and no less when another workflow has the new id, and come back on undo', async () => {
    const ci = 'on: push\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: a }]\n';
    const deploy = 'on: push\njobs:\n  compile:\n    runs-on: x\n    steps: [{ run: c }]\n';
    const { store, session } = await opened({ [CI]: ci, [DEPLOY]: deploy });
    store.getState().setAssume([{ job: 'build', outcome: 'failure' }]);
    await planned(store);
    const before = results(store);
    await rename(store, session);
    await planned(store);
    expect(results(store)).toEqual({ 'ci.yml:compile': 'failure', 'deploy.yml:compile': 'success' });
    expect(store.getState().undo()).toBe(true);
    await planned(store);
    expect(results(store)).toEqual(before);
    expect(store.getState().assume).toEqual([{ job: 'build', outcome: 'failure' }]);
  });

  it('keep covering the renamed job when another workflow shares the old id', async () => {
    const ci = 'on: push\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: a }]\n';
    const { store, session } = await opened({ [CI]: ci, [DEPLOY]: ci.replace('a }', 'c }') });
    store.getState().setAssume([{ job: 'build', outcome: 'failure' }]);
    await planned(store);
    await rename(store, session);
    await planned(store);
    expect(results(store)).toEqual({ 'ci.yml:compile': 'failure', 'deploy.yml:build': 'failure' });
  });

  it('follow a Revert of the renamed file back to the job they were made on', async () => {
    const { store, session } = await opened({ [CI]: WF });
    store.getState().setAssume([{ job: 'build', outcome: 'failure' }]);
    await planned(store);
    await rename(store, session);
    await planned(store);
    expect(store.getState().transact(revertOf(store.getState().files, CI, 'base')!).ok).toBe(true);
    await planned(store);
    expect(text(store)).toBe(WF);
    expect(store.getState().assume).toEqual([{ job: 'build', outcome: 'failure' }]);
    expect(results(store)).toEqual({ 'ci.yml:build': 'failure', 'ci.yml:test': 'skipped' });
    // Undoing the revert renames them again.
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().assume).toEqual([{ job: 'compile', outcome: 'failure' }]);
  });

  it('match a job as the engine does, exactly: one spelled in another case is left as it is', async () => {
    const { store, session } = await opened({ [CI]: WF });
    store.getState().setAssume([{ job: 'Build', outcome: 'failure' }]);
    await planned(store);
    await rename(store, session);
    await planned(store);
    expect(store.getState().assume).toEqual([{ job: 'Build', outcome: 'failure' }]);
    expect(results(store)['ci.yml:compile']).toBe('success');
  });
});

describe('the assume entries through callers and legs', () => {
  it('follow a called job renamed in its own file (`call/inner`)', async () => {
    const reusable = '.github/workflows/reusable.yml';
    const { store, session } = await opened({
      [CI]: 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n',
      [reusable]: 'on: workflow_call\njobs:\n  inner:\n    runs-on: x\n    steps: [{ run: a }]\n',
    });
    store.getState().setAssume([{ job: 'call/inner', outcome: 'failure' }]);
    await planned(store);
    const target = jobTarget(store, reusable, 'inner');
    expect(await dispatchRename({ store, session }, target, 'compile')).toMatchObject({ ok: true });
    await planned(store);
    expect(store.getState().assume).toEqual([{ job: 'call/compile', outcome: 'failure' }]);
    const call = store.getState().plan?.plan.workflows.find((w) => w.path === CI)?.jobs[0]?.legs[0]?.call;
    expect(call?.jobs.find((j) => j.jobId === 'compile')?.result).toMatchObject({ value: 'failure' });
  });

  it('follow a job whose leg selector holds brackets', async () => {
    const wf =
      "on: push\njobs:\n  build:\n    runs-on: x\n    strategy: { matrix: { install: ['.[dev]', '.[test]'] } }\n    steps:\n      - id: detect\n        run: pip install ${{ matrix.install }}\n";
    const { store, session } = await opened({ [CI]: wf });
    store.getState().setAssume([{ job: 'build[install=.[dev]]', outcome: 'failure' }]);
    await planned(store);
    await rename(store, session);
    await planned(store);
    expect(store.getState().assume).toEqual([{ job: 'compile[install=.[dev]]', outcome: 'failure' }]);
  });
});

describe('the selection after a rename', () => {
  it('keeps the leg when a step selected in it by position gets its first id', async () => {
    const wf =
      'on: push\njobs:\n  build:\n    runs-on: x\n    strategy: { matrix: { os: [a, b] } }\n    steps:\n      - uses: actions/setup-node@v4\n      - run: echo\n';
    const { store, session } = await opened({ [CI]: wf });
    store.getState().select(CI, 'build[os=b].#1');
    const read = targetOf(store, CI, store.getState().sel, { planned: true })!;
    const target: RenameTarget = { file: read.file, rev: read.rev, job: read.job!, step: read.step! };
    expect(await dispatchRename({ store, session }, target, 'setup-node')).toMatchObject({ ok: true });
    await planned(store);
    const s = store.getState();
    expect(s.sel).toBe('build[os=b].setup-node');
    expect(resolveSelection(planIndex(s.plan!), CI, s.sel)).toBe(`${CI}#build[os=b]/steps.setup-node`);
  });
});

describe('the post-condition and the refusals after an undo or a new source', () => {
  it('says nothing of a rename undone before the Outline of its text came', async () => {
    const { store, session } = await opened({ [CI]: WF });
    await rename(store, session);
    expect(store.getState().undo()).toBe(true);
    await planned(store);
    await new Promise((done) => setTimeout(done, 0));
    expect(store.getState().notices.map((n) => n.text)).toEqual(['Renamed job build to compile']);
  });

  it('keeps no refusal about the files a new source replaced', async () => {
    const { store, session } = await opened({ [CI]: WF });
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#\n' }], 'paste');
    const waiting = dispatchRename({ store, session }, jobTarget(store, CI, 'build'), 'compile');
    store.getState().setFiles({ [CI]: WF }, { kind: 'folder', name: 'other', readAt: 1 });
    expect((await waiting).ok).toBe(false);
    expect(store.getState().edit.refused).toBeUndefined();
    // Nor does it rename the job of the same path in the files that came.
    await planned(store);
    expect(text(store)).toBe(WF);
  });
});

describe('the fixes a rename’s refusal offers', () => {
  /** The rename dispatched with the worker's references, as `dispatchRename` does, refused for a shared anchor. */
  async function refused(wf: string, target: (store: SessionStore) => RenameTarget, to: string) {
    const { store, session } = await opened({ [CI]: wf });
    const t = target(store);
    const found = await findRefs(session, store, t);
    if (!found.ok) throw new Error(found.message);
    const op = t.step
      ? ({ op: 'renameStepId', file: CI, job: t.job, index: t.step.index, fp: t.step.fp, to } as const)
      : ({ op: 'renameJob', file: CI, job: t.job, to } as const);
    const result = dispatch(store, op, {
      refs: found.refs,
      revs: { [CI]: found.revs[CI]! },
      label: 'Renamed',
    });
    if (result.ok) throw new Error('expected a refusal');
    return { store, refused: result.refused, labels: result.refused.refusal.fixes.map((f: Fix) => f.label) };
  }
  const head = 'on: push\njobs:\n  build:\n    runs-on: x\n    outputs: { x: a }\n    steps: [{run: a}]\n';
  const job = (store: SessionStore): RenameTarget => jobTarget(store, CI, 'build');

  it('offer no copy before the rename, whose references would point at the wrong bytes; Change all stays', async () => {
    const wf = `${head}  a:\n    needs: build\n    runs-on: x\n    env: &e\n      X: \${{ needs.build.outputs.x }}\n    steps: [{run: a}]\n  b:\n    needs: build\n    runs-on: x\n    env: *e\n    steps: [{run: b}]\n`;
    const { store, refused: r, labels } = await refused(wf, job, 'compile');
    expect(r.refusal.reason).toBe('shared-anchor');
    expect(labels.some((l) => l.startsWith('Change only here'))).toBe(false);
    expect(text(store)).toBe(wf);
    const all = r.refusal.fixes.find((f) => f.kind === 'shared-all');
    expect(all).toBeDefined();
    expect(applyFix(store, r, all!)?.ok).toBe(true);
    expect(text(store)).toBe(wf.replaceAll('build', 'compile'));
  });

  it('offer no Change all for a step id, which each job reads as its own', async () => {
    const wf = `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - id: s\n        run: echo\n      - run: &r echo \${{ steps.s.outputs.x }}\n  b:\n    runs-on: x\n    steps:\n      - id: s\n        run: echo\n      - run: *r\n`;
    const step = (store: SessionStore): RenameTarget => ({
      ...jobTarget(store, CI, 'a'),
      step: { index: 0, fp: fingerprint(documents(store).of(store.getState(), CI)!, 'a', 0)! },
    });
    const { store, refused: r } = await refused(wf, step, 'probe');
    expect(r.refusal.fixes.filter((f) => f.kind === 'shared-all' || f.kind === 'ops')).toEqual([]);
    expect(text(store)).toBe(wf);
  });
});

describe('what the lookup says it leaves', () => {
  const job = (store: SessionStore): RenameTarget => jobTarget(store, CI, 'build');
  const head =
    'on: push\njobs:\n  build:\n    runs-on: x\n    outputs: { x: a }\n    steps: [{run: a}]\n  test:\n    needs: build\n    runs-on: x\n';
  it.each([
    ['a misspelt function', "    if: contians(needs.build.outputs.x, 'a')\n    steps: [{run: a}]\n"],
    ['a trailing operator', "    if: needs.build.result == 'success' &&\n    steps: [{run: a}]\n"],
    ['an unterminated ${{', '    steps:\n      - run: echo ${{ needs.build.result }\n'],
    [
      'a broken expression before a good one',
      '    steps:\n      - run: echo ${{ needs.build.result == }} ${{ needs.build.outputs.x }}\n',
    ],
  ])('names a read in an expression that does not parse (%s)', async (_, rest) => {
    const { store, session } = await opened({ [CI]: head + rest });
    const found = await findRefs(session, store, job(store));
    if (!found.ok) throw new Error(found.message);
    expect(found.exact).toBe(false);
    expect(found.notes).toEqual([
      expect.stringMatching(/^Line \d+ has an expression simulci cannot read; build in it is not renamed\.$/),
    ]);
  });

  it('places the references of a file with a byte-order mark on its first line', async () => {
    const wf =
      '\ufeff{on: push, jobs: {build: {runs-on: x, steps: [{run: a}]}, test: {needs: build, runs-on: x, if: "needs.build.result == \'success\'", steps: [{run: b}]}}}\n';
    const { store, session } = await opened({ [CI]: wf });
    const result = await dispatchRename({ store, session }, job(store), 'compile');
    expect(result.ok ? 'ok' : result.refused.refusal.message).toBe('ok');
    expect(text(store)).toBe(wf.replaceAll('build', 'compile'));
  });
});
