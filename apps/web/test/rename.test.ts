/**
 * Renames with their references (synthesis § 3.3, § 9.2 C11, § 9.4 row 17): the worker finds where an id is written
 * and what it cannot follow; the rename waits for the worker to hold the newest texts, checks the revision the
 * references were found in, and commits one entry, which undo takes back to the same bytes; a text that moved is looked
 * up once more; the next Outline is checked, and a rename that did not hold is undone while it is the newest entry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '@simulci/document';
import type { ReferenceTarget } from '@simulci/engine';
import { readWorkflowFiles } from '@simulci/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameProblem, startingId, summaryOf, takenIds } from '../src/edit/rename/form';
import {
  dispatchRename,
  findRefs,
  preview,
  type RenameTarget,
  renameBroken,
  watchRename,
} from '../src/edit/rename/run';
import { testsNaming } from '../src/edit/rename/tests';
import { documents } from '../src/edit/documents';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';
import type { EngineResponse, Outline, RefsResponse } from '../src/worker/protocol';
import { CI, disposeSessions, FOLDER, jobTarget, opened, planned, text as textOf } from './rename-harness';

const RELEASE = '.github/workflows/release.yml';
const FLOWPACT = readFileSync(
  fileURLToPath(new URL('../e2e/fixtures/flowpact/release.yml', import.meta.url)),
  'utf8',
);

afterEach(() => {
  disposeSessions();
  vi.restoreAllMocks();
});

const text = (store: SessionStore, path = RELEASE): string => textOf(store, path);

describe('the worker’s refs', () => {
  const refs = (files: Record<string, string>, target: ReferenceTarget): EngineResponse => {
    let state = initialState();
    const loaded = handle(state, { id: 1, type: 'load', files });
    state = loaded.state;
    const project = loaded.response.type === 'loaded' ? loaded.response.project : 0;
    return handle(state, { id: 2, type: 'refs', project, target }).response;
  };

  it('finds every place flowpact’s release.yml writes resolve, cut to the id, and nothing it cannot follow', () => {
    const answer = refs({ [RELEASE]: FLOWPACT }, { kind: 'job', workflow: RELEASE, job: 'resolve' });
    expect(answer.type).toBe('refs');
    const r = answer as RefsResponse;
    const roles: Record<string, number> = {};
    for (const x of r.refs) roles[x.role] = (roles[x.role] ?? 0) + 1;
    expect(roles).toEqual({ key: 1, needs: 10, read: 42 });
    expect(r.refs.every((x) => x.text === 'resolve')).toBe(true);
    expect(r).toMatchObject({ exact: true, notes: [] });
  });

  it('says which reads it leaves: a computed index, the whole context, an id spelled with an escape', () => {
    const wf = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo
  test:
    needs: build
    strategy:
      matrix:
        dep: [build]
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ needs[matrix.dep].result }}"
      - run: echo "\${{ toJSON(needs) }}"
      - run: "echo \${{ needs.\\x62uild.result }}"
      - run: echo "\${{ needs.build.result }}"
  other:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ toJSON(needs) }}"
`;
    const r = refs({ [CI]: wf }, { kind: 'job', workflow: CI, job: 'build' }) as RefsResponse;
    expect(r.refs.map((x) => x.role)).toEqual(['key', 'needs', 'read']);
    expect(r.exact).toBe(false);
    expect(r.notes).toEqual([
      '`needs[matrix.dep].result` (line 14) reads a job it computes; it is not renamed.',
      '`needs` (line 15) reads a job it computes; it is not renamed.',
      'Line 16 spells build with an escape; that read is not renamed.',
    ]);
  });

  it('is refused by shape: a target without a job is no request', async () => {
    const { isEngineRequest } = await import('../src/worker/protocol');
    expect(
      isEngineRequest({ id: 1, type: 'refs', project: 1, target: { kind: 'job', workflow: CI, job: 'b' } }),
    ).toBe(true);
    expect(isEngineRequest({ id: 1, type: 'refs', project: 1, target: { kind: 'job', workflow: CI } })).toBe(
      false,
    );
    expect(
      isEngineRequest({ id: 1, type: 'refs', project: 1, target: { kind: 'step', workflow: CI, job: 'b' } }),
    ).toBe(false);
    expect(isEngineRequest({ id: 1, type: 'refs', target: { kind: 'job', workflow: CI, job: 'b' } })).toBe(
      false,
    );
  });
});

describe('dispatchRename', () => {
  it('renames flowpact’s resolve to tag-resolve: every reference, not the 3 output declarations, one undo step', async () => {
    const { store, session } = await opened({ [RELEASE]: FLOWPACT });
    store.getState().select(RELEASE, 'resolve');
    const result = await dispatchRename(
      { store, session },
      jobTarget(store, RELEASE, 'resolve'),
      'tag-resolve',
    );
    expect(result).toMatchObject({ ok: true, changed: true, label: 'Renamed job resolve to tag-resolve' });
    const after = text(store);
    expect(FLOWPACT.includes('tag-resolve')).toBe(false);
    expect(after.split('tag-resolve').length - 1).toBe(53);
    // Only the id changed, at those 53 places: the 3 output declarations (`tag:`, `version:`, `prerelease:`) stay.
    expect(after.replaceAll('tag-resolve', 'resolve')).toBe(FLOWPACT);
    const changed = after.split('\n').filter((line, i) => line !== FLOWPACT.split('\n')[i]);
    expect(changed).toHaveLength(52);
    expect(changed.some((l) => /^\s+(tag|version|prerelease): \$\{\{ steps/.test(l))).toBe(false);
    expect(store.getState().edit.past).toHaveLength(1);
    // The selection follows the job once the plan of the new text is in, and the change maps the old ids to the new.
    await planned(store);
    expect(store.getState().sel).toBe('tag-resolve');
    const change = store.getState().change;
    expect(change?.renames).toEqual({ [`${RELEASE}#resolve`]: `${RELEASE}#tag-resolve` });
    expect(change?.after?.rows.filter((r) => r.kind === 'job' && r.change !== 'changed')).toEqual([]);
    // The worker finds the new id where the old one was, and no job called resolve.
    const again = await session.refs({ kind: 'job', workflow: RELEASE, job: 'tag-resolve' });
    expect(again.ok && again.refs.length).toBe(53);
    const gone = await session.refs({ kind: 'job', workflow: RELEASE, job: 'resolve' });
    expect(gone.ok && gone.refs).toEqual([]);
    expect(store.getState().undo()).toBe(true);
    expect(text(store)).toBe(FLOWPACT);
    expect(store.getState().edit.past).toHaveLength(0);
    await planned(store);
    expect(store.getState().sel).toBe('resolve');
    expect(store.getState().redo()).toBe(true);
    expect(text(store)).toBe(after);
  });

  it('waits for the worker to load texts typed a moment ago before it looks for references', async () => {
    const { store, session, client } = await opened({
      [CI]: 'on: push\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: a }]\n',
    });
    const typed =
      'on: push\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: a }]\n  test:\n    needs: build\n    runs-on: x\n    steps: [{ run: b }]\n';
    store.getState().typed(CI, [{ from: 0, to: text(store, CI).length, insert: typed }]);
    const result = await dispatchRename({ store, session }, jobTarget(store, CI, 'build'), 'compile');
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(text(store, CI)).toBe(typed.replaceAll('build', 'compile'));
    const kinds = client.sent.map((r) => r.type);
    expect(kinds.lastIndexOf('load')).toBeLessThan(kinds.lastIndexOf('refs'));
  });

  it('looks the references up once more when the text moved after they were found, then renames', async () => {
    const { store, session } = await opened({
      [CI]: 'on: push\njobs:\n  build:\n    steps: [{ run: a }]\n  test:\n    needs: build\n    steps: [{ run: b }]\n',
    });
    const found = await findRefs(session, store, jobTarget(store, CI, 'build'));
    if (!found.ok) throw new Error(found.message);
    // A comment typed above every reference: the positions found are off by its length.
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '# CI\n' }], 'paste');
    const spy = vi.spyOn(session, 'refs');
    const result = await dispatchRename({ store, session }, jobTarget(store, CI, 'build'), 'compile', found);
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(text(store, CI)).toBe(
      '# CI\non: push\njobs:\n  compile:\n    steps: [{ run: a }]\n  test:\n    needs: compile\n    steps: [{ run: b }]\n',
    );
  });

  it('refuses stale, writing nothing, when the text keeps moving under the lookup', async () => {
    const { store, session } = await opened({ [CI]: 'on: push\njobs:\n  build:\n    steps: [{ run: a }]\n' });
    const real = session.refs.bind(session);
    vi.spyOn(session, 'refs').mockImplementation(async (target) => {
      const answer = await real(target);
      store.getState().typed(CI, [{ from: 0, to: 0, insert: '#\n' }], 'paste');
      return answer;
    });
    const before = text(store, CI);
    const result = await dispatchRename({ store, session }, jobTarget(store, CI, 'build'), 'compile');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refused.refusal).toMatchObject({ reason: 'stale', file: CI });
    expect(text(store, CI)).toBe(`#\n#\n${before}`);
    expect(store.getState().edit.refused?.refusal.reason).toBe('stale');
  });

  it('answers current() at once for the texts loaded, and says so when other files replace them', async () => {
    const { store, session } = await opened({ [CI]: 'on: push\njobs:\n  build:\n    steps: [{ run: a }]\n' });
    await expect(session.current()).resolves.toMatchObject({
      ok: true,
      files: store.getState().files.version,
    });
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#\n' }], 'paste');
    const waiting = session.current();
    store.getState().setFiles({ [RELEASE]: FLOWPACT }, FOLDER);
    await expect(waiting).resolves.toEqual({ ok: false, message: 'Other files were opened.' });
  });

  it('says why when the newest texts do not parse, and writes nothing', async () => {
    const { store, session } = await opened({ [CI]: 'on: push\njobs:\n  build:\n    steps: [{ run: a }]\n' });
    store.getState().typed(CI, [{ from: 0, to: 0, insert: 'x: [\n' }], 'paste');
    const result = await dispatchRename({ store, session }, jobTarget(store, CI, 'build'), 'compile');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refused.refusal.message).toMatch(/valid YAML/);
  });

  it('gives a step without an id its first one, nothing to look up', async () => {
    const { store, session, client } = await opened({
      [CI]: 'on: push\njobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n',
    });
    const doc = documents(store).of(store.getState(), CI)!;
    const target: RenameTarget = {
      ...jobTarget(store, CI, 'build'),
      step: { index: 0, fp: fingerprint(doc, 'build', 0)! },
    };
    expect(startingId(target, takenIds(doc, target))).toBe('setup-node');
    const sent = client.sent.length;
    const result = await dispatchRename({ store, session }, target, 'setup-node');
    expect(result).toMatchObject({ ok: true, label: 'Gave step 1 of build the id setup-node' });
    expect(client.sent.slice(sent).map((r) => r.type)).not.toContain('refs');
    expect(text(store, CI)).toBe(
      'on: push\njobs:\n  build:\n    steps:\n      - id: setup-node\n        uses: actions/setup-node@v4\n',
    );
  });

  it('renames a step id and its reads, and the selection of its leg follows', async () => {
    const wf =
      'on: push\njobs:\n  build:\n    runs-on: x\n    strategy: { matrix: { os: [a, b] } }\n    steps:\n      - id: detect\n        run: echo\n      - run: echo ${{ steps.detect.outputs.x }}\n';
    const { store, session } = await opened({ [CI]: wf });
    store.getState().select(CI, 'build[os=a].detect');
    const doc = documents(store).of(store.getState(), CI)!;
    const target: RenameTarget = {
      ...jobTarget(store, CI, 'build'),
      step: { index: 0, fp: fingerprint(doc, 'build', 0)! },
    };
    const result = await dispatchRename({ store, session }, target, 'probe');
    expect(result).toMatchObject({ ok: true, label: 'Renamed step build.detect to probe' });
    expect(text(store, CI)).toBe(wf.replaceAll('detect', 'probe'));
    expect(store.getState().change?.renames).toEqual({
      [`${CI}#build[os=a]/steps.detect`]: `${CI}#build[os=a]/steps.probe`,
      [`${CI}#build[os=b]/steps.detect`]: `${CI}#build[os=b]/steps.probe`,
    });
    await planned(store);
    expect(store.getState().sel).toBe('build[os=a].probe');
  });
});

describe('a rename over this repository’s own files', () => {
  it('renames ci.yml’s fallow job, and counts the cases of ci.test.yml that still name it', async () => {
    const root = join(import.meta.dirname, '../../..');
    const tests = '.github/simulci/tests/ci.test.yml';
    const byPath: Record<string, string> = {
      ...readWorkflowFiles(root),
      [tests]: readFileSync(join(root, tests), 'utf8'),
    };
    const { store, session } = await opened(byPath);
    const target = jobTarget(store, CI, 'fallow');
    const found = await findRefs(session, store, target);
    if (!found.ok) throw new Error(found.message);
    const p = preview(store, target, 'code-health', found);
    if (!p.ok) throw new Error(p.refusal.message);
    expect(p.warnings.map((w) => w.message)).toContain(
      '2 cases in ci.test.yml name fallow; they are not renamed.',
    );
    expect(await dispatchRename({ store, session }, target, 'code-health', found)).toMatchObject({
      ok: true,
    });
    const after = textOf(store, CI);
    expect(after.replaceAll('code-health', 'fallow')).toBe(byPath[CI]);
    expect(textOf(store, tests)).toBe(byPath[tests]);
    await planned(store);
    expect(store.getState().notices.map((n) => n.text)).toEqual([
      'Renamed job fallow to code-health. 2 cases in ci.test.yml name fallow; they are not renamed.',
    ]);
  });
});

describe('the rename popover’s list', () => {
  it('lists every line the rename writes, with what it leaves', async () => {
    const test =
      'workflow: ci.yml\ncases:\n  - name: a\n    when: { event: push }\n    then: { run: [build, test] }\n  - name: b\n    when: { event: push }\n    then: { run: [test] }\n';
    const wf =
      "on: push\njobs:\n  build:\n    steps: [{ run: a }]\n  test:\n    needs: [build]\n    if: needs.build.result == 'success'\n    steps: [{ run: b }]\n";
    const { store, session } = await opened({ [CI]: wf, '.github/simulci/tests/ci.test.yml': test });
    const target = jobTarget(store, CI, 'build');
    const found = await findRefs(session, store, target);
    if (!found.ok) throw new Error(found.message);
    const p = preview(store, target, 'compile', found);
    if (!p.ok) throw new Error(p.refusal.message);
    expect(p.lines).toEqual([
      { line: 3, text: '  build:' },
      { line: 6, text: '    needs: [build]' },
      { line: 7, text: "    if: needs.build.result == 'success'" },
    ]);
    expect(summaryOf(target, p)).toBe(
      '3 places on 3 lines of ci.yml: the key, 1 needs entry and 1 expression read.',
    );
    expect(p.warnings.map((w) => w.message)).toEqual([
      '1 case in ci.test.yml names build; it is not renamed.',
    ]);
    expect(text(store, CI)).toBe(wf);
    expect(store.getState().edit.past).toHaveLength(0);
  });

  it('says why an id cannot be the new one', () => {
    const job: RenameTarget = { file: CI, rev: 1, job: 'build' };
    expect(renameProblem(job, '2nd', ['test'])).toBe(
      'Job ids start with a letter or _, then letters, digits, - or _.',
    );
    expect(renameProblem(job, 'TEST', ['test'])).toBe('A job test already exists; ids ignore case.');
    expect(renameProblem(job, 'Build', ['test'])).toBeUndefined();
    const step: RenameTarget = { ...job, step: { index: 1, fp: {} } };
    expect(renameProblem(step, 'detect', ['Detect'])).toBe(
      'Step Detect of build already has it; ids ignore case.',
    );
  });
});

describe('the route tests a rename leaves', () => {
  const rename = { kind: 'job', file: CI, job: 'build', from: 'build', to: 'compile' } as const;
  it('counts the cases and the given of the workflow’s test files that name the old id', () => {
    const named = `workflow: .github/workflows/ci.yml
given: { assume: [{ job: build, outcome: success }] }
cases:
  - name: a
    when: { event: push, assume: [{ step: build.test, outcome: failure }] }
    then: { units: { 'build[os=a].#2': { runs: yes } } }
  - name: b
    when: { event: push }
    then: { skip: [{ build: if }] }
  - name: c
    when: { event: push }
    then: { run: [builder, test] }
`;
    expect(
      testsNaming(
        {
          '.github/simulci/tests/ci.test.yml': named,
          '.github/simulci/tests/release.test.yml':
            'workflow: release.yml\ncases:\n  - name: a\n    when: {}\n    then: { run: [build] }\n',
          [CI]: 'jobs: {}\n',
        },
        rename,
      ).map((w) => w.message),
    ).toEqual(["ci.test.yml's given and 2 cases name build; they are not renamed."]);
  });

  it('says nothing for a test file that does not parse or names something else', () => {
    expect(testsNaming({ '.github/simulci/tests/ci.test.yml': 'workflow: [' }, rename)).toEqual([]);
    expect(testsNaming({ '.github/simulci/tests/ci.test.yml': 'workflow: ci\ncases: []\n' }, rename)).toEqual(
      [],
    );
  });
});

describe('the post-condition on the next Outline', () => {
  const outline = (jobs: { id: string; needs?: string[]; steps?: string[] }[]): Outline => ({
    files: [],
    events: {},
    workflows: [
      {
        path: CI,
        callable: false,
        events: [],
        onLine: 1,
        jobs: jobs.map((j) => ({
          id: j.id,
          needs: j.needs ?? [],
          matrix: false,
          line: 1,
          steps: (j.steps ?? []).map((id, index) => ({ index, id, line: 1 })),
        })),
      },
    ],
  });
  const job = { kind: 'job', file: CI, job: 'build', from: 'build', to: 'compile' } as const;

  it('holds when no needs names the old id and the new one is there', () => {
    expect(
      renameBroken(outline([{ id: 'compile' }, { id: 'test', needs: ['compile'] }]), job),
    ).toBeUndefined();
    expect(renameBroken(undefined, job)).toBeUndefined();
  });

  it('fails when a needs still names the old id, whatever its case, or the new id is not there', () => {
    expect(renameBroken(outline([{ id: 'compile' }, { id: 'test', needs: ['Build'] }]), job)).toBe(
      'test still needs build',
    );
    expect(renameBroken(outline([{ id: 'build' }]), job)).toBe('no job has the id compile');
    const caseOnly = { ...job, to: 'Build' };
    expect(renameBroken(outline([{ id: 'Build' }, { id: 't', needs: ['Build'] }]), caseOnly)).toBeUndefined();
    const step = { kind: 'step', file: CI, job: 'build', from: 'detect', to: 'probe' } as const;
    expect(renameBroken(outline([{ id: 'build', steps: ['detect'] }]), step)).toBe(
      'no step of build has the id probe',
    );
    expect(renameBroken(outline([{ id: 'build', steps: ['probe'] }]), step)).toBeUndefined();
  });

  /** A store with one rename committed at the top of the history. */
  function renamed() {
    const store = createSessionStore();
    const s = store.getState();
    s.setFiles({ [CI]: 'jobs:\n  build: {}\n' }, FOLDER);
    s.projectReady(1, outline([{ id: 'build' }]), store.getState().files.version);
    s.transact({
      label: 'Renamed job build to compile',
      origin: 'op',
      files: [{ path: CI, edits: [{ from: 8, to: 13, insert: 'compile' }] }],
    });
    const tx = store.getState().edit.past.at(-1)!;
    return { store, tx, files: store.getState().files.version };
  }

  it('undoes the rename and says why when the Outline of its text says it did not hold', async () => {
    const { store, tx, files } = renamed();
    watchRename(store, tx, [job], files);
    store.getState().projectReady(2, outline([{ id: 'compile' }, { id: 'test', needs: ['build'] }]), files);
    await vi.waitFor(() => expect(store.getState().edit.past).toHaveLength(0));
    expect(text(store, CI)).toBe('jobs:\n  build: {}\n');
    expect(store.getState().notices.at(-1)?.text).toBe(
      'Undid “Renamed job build to compile”: test still needs build.',
    );
  });

  it('only says so when another edit came after it, and stops at the first Outline of its text', async () => {
    const { store, tx, files } = renamed();
    watchRename(store, tx, [job], files);
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#\n' }], 'paste');
    // The Outline of the renamed text, arriving after the edit that followed it.
    store.getState().projectReady(2, outline([{ id: 'compile' }, { id: 'test', needs: ['build'] }]), files);
    await vi.waitFor(() => expect(store.getState().notices).toHaveLength(1));
    expect(store.getState().edit.past).toHaveLength(2);
    expect(store.getState().notices[0]?.text).toMatch(
      /did not hold: test still needs build\. Fix it in the YAML pane, or undo it\./,
    );
    store
      .getState()
      .projectReady(3, outline([{ id: 'compile' }, { id: 'test', needs: ['build'] }]), files + 1);
    await Promise.resolve();
    expect(store.getState().notices).toHaveLength(1);
  });

  it('says nothing of an Outline of later edits, nor of a rename undone', async () => {
    const later = renamed();
    watchRename(later.store, later.tx, [job], later.files);
    later.store.getState().typed(CI, [{ from: 0, to: 0, insert: '#\n' }], 'paste');
    later.store
      .getState()
      .projectReady(2, outline([{ id: 'compile' }, { id: 'test', needs: ['build'] }]), later.files + 1);
    const undone = renamed();
    watchRename(undone.store, undone.tx, [job], undone.files);
    undone.store.getState().undo();
    undone.store
      .getState()
      .projectReady(2, outline([{ id: 'build' }, { id: 'test', needs: ['build'] }]), undone.files + 1);
    await Promise.resolve();
    expect(later.store.getState().notices).toEqual([]);
    expect(later.store.getState().edit.past).toHaveLength(2);
    expect(undone.store.getState().notices).toEqual([]);
  });

  it('waits for an Outline of its text, and lets a rename that held be', async () => {
    const { store, tx, files } = renamed();
    watchRename(store, tx, [job], files);
    store.getState().projectReady(2, outline([{ id: 'build' }]), files - 1);
    await Promise.resolve();
    expect(store.getState().edit.past).toHaveLength(1);
    store.getState().projectReady(3, outline([{ id: 'compile' }]), files);
    await Promise.resolve();
    expect(store.getState().edit.past).toHaveLength(1);
    expect(store.getState().notices).toEqual([]);
  });
});
