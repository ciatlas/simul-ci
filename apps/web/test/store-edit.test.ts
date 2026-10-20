import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphState } from '../src/graph/types';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { stampOf } from '../src/state/history';
import { sourceStore } from '../src/state/persist';
import { createSessionStore, type PlanState, withTexts } from '../src/state/store';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const FOLDER = { kind: 'folder', name: 'repo', readAt: 0 } as const;

/** A store showing a plan and a picture of two workflows, with a node selected. */
function showing() {
  const store = createSessionStore();
  const a = store.getState();
  a.setFiles({ [CI]: 'on: push\n', [RELEASE]: 'on: release\r\n' }, FOLDER);
  const { epoch, version } = store.getState().files;
  const plan = { for: { files: version, epoch, project: 1 } } as PlanState;
  a.planReceived(plan);
  a.graphReady({ for: plan.for } as GraphState);
  a.select(CI, 'build');
  return { store, plan };
}

describe('edits through the store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits a transaction with the texts in one update, and keeps the epoch, the base, the plan and the selection', () => {
    const { store, plan } = showing();
    const before = store.getState();
    const updates: number[] = [];
    store.subscribe((s) => updates.push(s.files.version));
    const outcome = before.transact({
      label: 'Added a comment',
      origin: 'op',
      files: [
        { path: CI, edits: [{ from: 0, to: 0, insert: '# ci\n' }], expect: stampOf('on: push\n') },
        { path: RELEASE, edits: [{ from: 4, to: 11, insert: '[release]' }] },
      ],
    });
    expect(outcome).toEqual({ ok: true });
    expect(updates).toEqual([2]);
    const after = store.getState();
    expect(after.files).toMatchObject({
      version: 2,
      epoch: 1,
      byPath: { [CI]: '# ci\non: push\n', [RELEASE]: 'on: [release]\r\n' },
      revs: { [CI]: 2, [RELEASE]: 2 },
    });
    expect(after.files.base).toBe(before.files.base);
    expect(after.files.opened).toBe(before.files.opened);
    expect([after.plan, after.graph, after.focus, after.sel]).toEqual([plan, before.graph, CI, 'build']);
    expect(after.stale).toBe('edit');
    expect(after.edit.past).toHaveLength(1);
    expect(after.edit.past[0]).toMatchObject({
      label: 'Added a comment',
      selection: { before: { focus: CI, sel: 'build' } },
    });
  });

  it('refuses a transaction planned against older text and changes nothing', () => {
    const { store } = showing();
    const before = store.getState();
    const outcome = before.transact({
      label: 'x',
      origin: 'op',
      files: [{ path: CI, edits: [{ from: 0, to: 0, insert: '#' }], expect: stampOf('on: pull_request\n') }],
    });
    expect(outcome).toEqual({ ok: false, refusal: { refused: 'stale', path: CI } });
    expect(store.getState()).toBe(before);
  });

  it('groups typed keys, undoes and redoes them, and moves the version each time', () => {
    const { store } = showing();
    const a = store.getState();
    a.typed(CI, [{ from: 8, to: 8, insert: ' ' }]);
    vi.advanceTimersByTime(50);
    a.typed(CI, [{ from: 9, to: 9, insert: '#' }]);
    expect(store.getState().files).toMatchObject({ version: 3, byPath: { [CI]: 'on: push #\n' } });
    expect(store.getState().edit).toMatchObject({
      past: [],
      lastOrigin: 'pane',
      group: { label: 'Typing in ci.yml' },
    });
    a.closeGroup();
    expect(store.getState().edit.past).toHaveLength(1);
    expect(store.getState().files.version).toBe(3);
    expect(a.undo()).toBe(true);
    expect(store.getState().files).toMatchObject({
      version: 4,
      byPath: { [CI]: 'on: push\n' },
      revs: { [CI]: 4 },
    });
    expect(store.getState().edit.lastOrigin).toBe('undo');
    expect(a.undo()).toBe(false);
    expect(a.redo()).toBe(true);
    expect(store.getState().files.byPath[CI]).toBe('on: push #\n');
  });

  it('clears the history and says so when an undo finds a file changed outside it', () => {
    const { store } = showing();
    const a = store.getState();
    a.transact({ label: 'x', origin: 'op', files: [{ path: CI, edits: [{ from: 0, to: 0, insert: '#' }] }] });
    store.setState((s) => withTexts(s, { [CI]: '#on: push\n!' }));
    expect(a.undo()).toBe(false);
    expect(store.getState().files.byPath[CI]).toBe('#on: push\n!');
    expect(store.getState().edit).toMatchObject({ past: [], future: [] });
    expect(store.getState().notices.map((n) => n.text)).toEqual([
      'undo stopped: ci.yml changed outside the history',
    ]);
  });

  it('starts the history over with a new source, and only then', () => {
    const { store } = showing();
    const a = store.getState();
    a.transact({ label: 'x', origin: 'op', files: [{ path: CI, edits: [{ from: 0, to: 0, insert: '#' }] }] });
    const { next } = store.getState().edit;
    a.setFiles({ [CI]: 'on: push\n' }, FOLDER);
    expect(store.getState().edit).toEqual({ past: [], future: [], next });
    a.transact({ label: 'y', origin: 'op', files: [{ path: CI, edits: [{ from: 0, to: 0, insert: '#' }] }] });
    a.forgetSource();
    expect(store.getState().edit.past).toEqual([]);
  });

  it('follows a file’s line endings in its meta and keeps what reading found', () => {
    const store = createSessionStore();
    store
      .getState()
      .setFiles({ [CI]: 'a\r\nb\n' }, FOLDER, { [CI]: { bom: true, eol: 'mixed', utf8: true } });
    store.getState().transact({
      label: 'Convert',
      origin: 'convert',
      files: [{ path: CI, edits: [{ from: 1, to: 3, insert: '\n' }] }],
    });
    expect(store.getState().files.meta[CI]).toEqual({ bom: true, eol: 'lf', utf8: true });
  });

  it('changes nothing, and says so, for an edit that leaves every text as it is', () => {
    const { store } = showing();
    const before = store.getState();
    expect(before.typed(CI, [{ from: 0, to: 2, insert: 'on' }])).toEqual({ ok: false });
    expect(before.transact({ label: 'x', origin: 'op', files: [{ path: CI, edits: [] }] })).toEqual({
      ok: false,
    });
    expect(store.getState()).toBe(before);
  });

  it('keeps what reading found of a file an edit removed, for the undo that brings it back', () => {
    const store = createSessionStore();
    store
      .getState()
      .setFiles({ [CI]: 'on: push\r\n' }, FOLDER, { [CI]: { bom: true, eol: 'crlf', utf8: true } });
    store
      .getState()
      .transact({ label: 'Removed', origin: 'op', files: [{ path: CI, edits: [], remove: true }] });
    expect(store.getState().files.byPath).toEqual({});
    store.getState().undo();
    expect(store.getState().files.meta[CI]).toEqual({ bom: true, eol: 'crlf', utf8: true });
  });

  it('keeps a file’s line ending while its text has no line break', () => {
    const store = createSessionStore();
    store.getState().setFiles({ [CI]: 'a\r\nb\r\n' }, FOLDER);
    store.getState().typed(CI, [{ from: 0, to: 6, insert: '' }]);
    expect(store.getState().files.meta[CI]!.eol).toBe('crlf');
  });

  it('creates and removes files, with their meta and revs', () => {
    const { store } = showing();
    const TEST = '.github/simulci/tests/ci.test.yml';
    const a = store.getState();
    a.transact({
      label: 'Created',
      origin: 'op',
      files: [{ path: TEST, edits: [{ from: 0, to: 0, insert: 'cases: []\n' }], create: true }],
    });
    expect(store.getState().files).toMatchObject({
      byPath: { [TEST]: 'cases: []\n' },
      meta: { [TEST]: { eol: 'lf' } },
    });
    expect(store.getState().files.base).not.toHaveProperty(TEST);
    // A test file is not in the plan: the plan is as current as it was.
    expect(store.getState().stale).toBe(false);
    a.undo();
    expect(store.getState().files.byPath).not.toHaveProperty(TEST);
    expect(store.getState().files.revs).not.toHaveProperty(TEST);
  });

  it('writes edits into pasted buffers, and turns an edited sample into the buffers of its copy', () => {
    const pasted = createSessionStore();
    pasted
      .getState()
      .setFiles({ [CI]: 'on: push\n' }, { kind: 'paste', buffers: [{ path: CI, text: 'on: push\n' }] });
    pasted.getState().typed(CI, [{ from: 0, to: 0, insert: '#' }]);
    expect(pasted.getState().source).toEqual({ kind: 'paste', buffers: [{ path: CI, text: '#on: push\n' }] });

    const sample = createSessionStore();
    sample
      .getState()
      .setFiles({ [CI]: 'on: push\n', [RELEASE]: 'on: release\n' }, { kind: 'sample', name: 'starter' });
    sample.getState().typed(RELEASE, [{ from: 0, to: 0, insert: '#' }]);
    expect(sample.getState().source).toEqual({
      kind: 'paste',
      name: 'edited copy of the starter sample',
      buffers: [
        { path: CI, text: 'on: push\n' },
        { path: RELEASE, text: '#on: release\n' },
      ],
    });
    // The base is still the sample: undoing back to it leaves nothing unsaved, and the copy stays a copy.
    sample.getState().undo();
    expect(sample.getState().files.byPath).toEqual(sample.getState().files.base);
    expect(sample.getState().source).toMatchObject({
      kind: 'paste',
      name: 'edited copy of the starter sample',
    });
    // Pasting another file keeps the copy's name; removing it does too.
    const sources = createSources({ store: sample, persist: sourceStore(memoryStore()) });
    sources.paste('.github/workflows/extra.yml', 'on: pull_request\n');
    expect(sample.getState().source).toMatchObject({
      kind: 'paste',
      name: 'edited copy of the starter sample',
    });
    sources.removeBuffer('.github/workflows/extra.yml');
    expect(sample.getState().source).toMatchObject({ name: 'edited copy of the starter sample' });
  });

  it('holds a broken load off the screen until a project of the newest texts is ready', () => {
    const { store } = showing();
    const a = store.getState();
    const outline = { files: [], workflows: [], events: {} };
    a.projectReady(1, outline, 1);
    a.projectHeld({ files: 2, outline, broken: [{ path: CI, line: 3 }] });
    expect(store.getState().project).toMatchObject({
      status: 'ready',
      version: 1,
      files: 1,
      held: { files: 2 },
    });
    a.projectReady(2, outline, 3);
    expect(store.getState().project.held).toBeUndefined();
  });
});
