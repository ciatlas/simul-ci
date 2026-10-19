// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view';
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { sampleByName } from '../src/input/samples';
import { createSessionStore, initialSessionState, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';
import type { Outline } from '../src/worker/protocol';
import {
  blankState,
  FLASH_MS,
  gutterNodes,
  lineClasses,
  lineStart,
  markedNode,
  PaneDocs,
  pageIsDark,
  paneState,
  scrollToLine,
  setDeciding,
  setFlash,
  setMarks,
  setProblems,
  themeFor,
} from '../src/yaml/extensions';
import { YamlPane } from '../src/yaml/YamlPane';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const SETUP = '.github/actions/setup/action.yml';
const starter = sampleByName('starter')!.files;

function simulated(files: Record<string, string>, scenario: ScenarioInput) {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  const { plan, derived, text, ms } = step.response;
  return {
    outline: loaded.response.outline,
    plan: { plan, derived, text, ms, for: { files: 1, project: 1 } },
  };
}

const main = simulated(starter, { event: 'push', branch: 'main', changed: ['src/a.ts'] });
const onMark = vi.fn();

afterEach(() => {
  cleanup();
  onMark.mockReset();
  delete document.documentElement.dataset.theme;
});

describe('the pane’s extensions', () => {
  const text = 'a: 1\nb: 2\nc: 3\n';
  const state = () => paneState(text, { path: 'x.yml', dark: false, onMark });

  it('are read-only, named for a screen reader, and draw the marks and lines the effects set', () => {
    const s = state().update({
      effects: [
        setMarks.of([
          { line: 1, node: 'n1', verdict: 'yes', title: 'one: runs' },
          { line: 3, node: 'n3', verdict: 'maybe', title: 'three: might run' },
          { line: 9, node: 'gone', verdict: 'no', title: 'past the end' },
        ]),
        setDeciding.of({ line: 2, tone: 'no', own: 3 }),
        setProblems.of([{ line: 3, message: 'bad' }]),
        setFlash.of(1),
      ],
    }).state;
    expect(s.readOnly).toBe(true);
    expect(gutterNodes(s)).toEqual(
      new Map([
        [1, 'n1'],
        [3, 'n3'],
      ]),
    );
    expect(lineClasses(s)).toEqual(
      new Map([
        [1, ['cm-sc-flash']],
        [2, ['cm-sc-deciding:no']],
        [3, ['cm-sc-own:no', 'cm-sc-problem']],
      ]),
    );
    expect(markedNode(s, s.doc.line(3).from)).toBe('n3');
    expect(markedNode(s, s.doc.line(2).from)).toBeUndefined();
    const cleared = s.update({
      effects: [setDeciding.of(undefined), setFlash.of(undefined), setMarks.of([])],
    }).state;
    expect(lineClasses(cleared)).toEqual(new Map([[3, ['cm-sc-problem']]]));
    expect(gutterNodes(cleared).size).toBe(0);
    expect(gutterNodes(blankState())).toEqual(new Map());
  });

  it('find lines only inside the document', () => {
    const s = state();
    expect([0, 1, 2, 4, 5, 1.5].map((line) => lineStart(s.doc, line))).toEqual([
      undefined,
      0,
      5,
      15,
      undefined,
      undefined,
    ]);
    expect(scrollToLine(s, 2, 'center')).toHaveLength(1);
    expect(scrollToLine(s, 40, 'center')).toEqual([]);
  });

  it('follow the page’s theme', () => {
    expect(pageIsDark()).toBe(false);
    document.documentElement.dataset.theme = 'dark';
    expect(pageIsDark()).toBe(true);
    expect(themeFor(true)).not.toBe(themeFor(false));
    expect(themeFor(true)).toBe(themeFor(true));
  });

  it('keep one state per file for a version of the files, and drop them for the next', () => {
    const parent = document.createElement('div');
    const view = new EditorView({ parent, state: blankState() });
    const made: string[] = [];
    const docs = new PaneDocs((path, doc) => {
      made.push(path);
      return paneState(doc, { path, dark: false, onMark });
    });
    expect(docs.show(view, 'a.yml', 1, 'a: 1')).toEqual([]);
    expect(view.state.doc.toString()).toBe('a: 1');
    expect(docs.show(view, 'a.yml', 1, 'a: 1')).toEqual([]);
    view.dispatch({
      effects: [setMarks.of([{ line: 1, node: 'n', verdict: 'yes', title: 'n' }]), setFlash.of(1)],
    });
    docs.show(view, 'b.yml', 1, 'b: 1');
    expect(docs.shown).toBe('b.yml');
    // Back to a file shown before: its own state, and where it was scrolled, without the flash it had.
    expect(docs.show(view, 'a.yml', 1, 'a: 1')).toHaveLength(1);
    expect(gutterNodes(view.state).get(1)).toBe('n');
    expect(lineClasses(view.state).size).toBe(0);
    docs.show(view, 'a.yml', 2, 'a: 2');
    expect(view.state.doc.toString()).toBe('a: 2');
    // Another view starts from nothing shown, with the states kept.
    const other = new EditorView({ parent, state: blankState() });
    docs.show(other, 'a.yml', 2, 'a: 2');
    expect(other.state.doc.toString()).toBe('a: 2');
    expect(made).toEqual(['a.yml', 'b.yml', 'a.yml']);
    view.destroy();
    other.destroy();
  });
});

describe('the YAML pane', () => {
  function mount(
    over: Partial<ReturnType<typeof initialSessionState>> = {},
    outline: Outline = main.outline,
  ) {
    const initial = initialSessionState();
    const store = createSessionStore({
      ...initial,
      files: { version: 1, byPath: starter },
      project: { status: 'ready', version: 1, outline, files: 3 },
      plan: main.plan,
      focus: CI,
      ui: {
        ...initial.ui,
        prefs: { ...initial.ui.prefs, collapsed: { left: false, right: false, yaml: false } },
      },
      ...over,
    });
    const result = render(
      <AppProvider app={{ store } as unknown as App}>
        <YamlPane />
      </AppProvider>,
    );
    return { store, ...result };
  }

  const tab = (name: RegExp | string) => screen.getByRole('tab', { name });
  const selected = (name: string) => tab(name).getAttribute('aria-selected');
  const viewOf = (container: HTMLElement) =>
    EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
  const content = (container: HTMLElement) => viewOf(container).contentDOM;
  // Only the first screenful is drawn without a layout: lines past it are read from the state.
  const lineOf = (container: HTMLElement, n: number) =>
    container.querySelectorAll<HTMLElement>('.cm-line')[n - 1];
  const classes = (container: HTMLElement) => lineClasses(viewOf(container).state);

  it('shows the loaded files as tabs, workflows first, and the file that decided the selection', () => {
    const { container } = mount({ sel: 'deploy' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'ci.yml',
      'release.yml',
      'action.yml',
    ]);
    expect(selected('ci.yml')).toBe('true');
    expect(selected('release.yml')).toBe('false');
    expect(tab('ci.yml').tabIndex).toBe(0);
    expect(tab('release.yml').tabIndex).toBe(-1);
    expect(tab('ci.yml').title).toBe(CI);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('ci.yml').id);
    expect(tab('ci.yml').getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);
    expect(content(container).getAttribute('aria-label')).toBe(`${CI}, read-only`);
    expect(content(container).getAttribute('contenteditable')).toBe('false');
    expect(content(container).tabIndex).toBe(0);
    expect(viewOf(container).state.doc.toString()).toBe(starter[CI]);
    // Keys stand out; the gutter is not read out.
    const keys = [...container.querySelectorAll('.cm-sc-key')].map((k) => k.textContent);
    expect(keys).toContain('runs-on');
    expect(keys).not.toContain('ubuntu-latest');
    expect(container.querySelector('.cm-gutters')?.getAttribute('aria-hidden')).toBe('true');
    expect(classes(container).get(43)).toEqual(['cm-sc-deciding:yes']);
    expect(classes(container).get(41)).toEqual(['cm-sc-own:yes']);
    expect(screen.getByText(CI, { selector: 'footer span' })).toBeTruthy();
    expect(screen.getByText('read-only in this version')).toBeTruthy();
  });

  it('marks the verdicts in the gutter, and a pressed mark selects its node without taking the focus', () => {
    const { container, store } = mount();
    expect(gutterNodes(viewOf(container).state).get(51)).toBe(`${CI}#preview`);
    const marks = [...container.querySelectorAll<HTMLElement>('.cm-sc-mark')];
    expect(marks.find((m) => m.dataset.node === CI)?.title).toBe('CI: runs');
    const build = marks.find((m) => m.dataset.node === `${CI}#build`)!;
    expect(build.title).toBe('build: runs');
    expect(build.getAttribute('aria-hidden')).toBe('true');
    expect(build.querySelector('circle')?.getAttribute('fill')).toBe('var(--run)');
    const before = document.activeElement;
    expect(fireEvent.mouseDown(build, { button: 2 })).toBe(true);
    expect(store.getState().sel).toBeUndefined();
    // Handled: the default (moving the focus) is prevented.
    expect(fireEvent.mouseDown(build, { button: 0 })).toBe(false);
    expect(store.getState()).toMatchObject({ focus: CI, sel: 'build' });
    expect(store.getState().ui.yamlFile).toBe(CI);
    expect(document.activeElement).toBe(before);
    expect(classes(container).get(30)).toEqual(['cm-sc-deciding:yes']);
    expect(lineOf(container, 30)?.dataset.tone).toBe('yes');
  });

  it('brings the deciding line to the middle when the selection changes, and only into view after a mark', () => {
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    try {
      const { container, store } = mount();
      const doc = viewOf(container).state.doc;
      // The focused workflow is selected first: its paths filter decided.
      expect(scroll).toHaveBeenLastCalledWith(doc.line(5).from, { y: 'center' });
      act(() => store.getState().select(CI, 'deploy'));
      expect(scroll).toHaveBeenLastCalledWith(doc.line(43).from, { y: 'center' });
      const calls = scroll.mock.calls.length;
      act(() => store.getState().planReceived({ ...main.plan }));
      expect(scroll).toHaveBeenCalledTimes(calls);
      const build = () => container.querySelector<HTMLElement>(`.cm-sc-mark[data-node="${CI}#build"]`)!;
      fireEvent.mouseDown(build(), { button: 0 });
      expect(scroll).toHaveBeenLastCalledWith(doc.line(30).from, { y: 'nearest' });
      // The selection's own mark moves nothing, and the next selection is centred again.
      fireEvent.mouseDown(build(), { button: 0 });
      act(() => store.getState().select(CI, 'deploy'));
      expect(scroll).toHaveBeenLastCalledWith(doc.line(43).from, { y: 'center' });
    } finally {
      scroll.mockRestore();
    }
  });

  it('works under React’s development double mount', () => {
    const initial = initialSessionState();
    const store = createSessionStore({
      ...initial,
      files: { version: 1, byPath: starter },
      project: { status: 'ready', version: 1, outline: main.outline, files: 3 },
      plan: main.plan,
      focus: CI,
    });
    const { container } = render(
      <StrictMode>
        <AppProvider app={{ store } as unknown as App}>
          <YamlPane />
        </AppProvider>
      </StrictMode>,
    );
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(content(container).getAttribute('aria-label')).toBe(`${CI}, read-only`);
    expect(gutterNodes(viewOf(container).state).get(16)).toBe(`${CI}#test`);
  });

  it('switches files by tab and by the arrow keys, and follows the selection again once it changes', () => {
    const { container, store } = mount();
    fireEvent.click(tab('release.yml'));
    expect(store.getState().ui.yamlFile).toBe(RELEASE);
    expect(container.querySelector<HTMLElement>('.cm-sc-mark')?.title).toBe('Release: skipped');
    fireEvent.click(tab('action.yml'));
    expect(store.getState().ui.yamlFile).toBe(SETUP);
    expect(content(container).getAttribute('aria-label')).toBe(`${SETUP}, read-only`);
    expect(selected('action.yml')).toBe('true');
    fireEvent.keyDown(tab('action.yml'), { key: 'ArrowRight' });
    expect(store.getState().ui.yamlFile).toBe(CI);
    expect(document.activeElement).toBe(tab('ci.yml'));
    fireEvent.keyDown(tab('ci.yml'), { key: 'ArrowLeft' });
    expect(store.getState().ui.yamlFile).toBe(SETUP);
    fireEvent.keyDown(tab('action.yml'), { key: 'Home' });
    expect(store.getState().ui.yamlFile).toBe(CI);
    fireEvent.keyDown(tab('ci.yml'), { key: 'End' });
    expect(store.getState().ui.yamlFile).toBe(SETUP);
    fireEvent.keyDown(tab('action.yml'), { key: 'x' });
    expect(store.getState().ui.yamlFile).toBe(SETUP);
    act(() => store.getState().select(RELEASE, undefined));
    expect(content(container).getAttribute('aria-label')).toBe(`${RELEASE}, read-only`);
    // Release is not triggered: its tags filter decided.
    expect(classes(container).get(4)).toEqual(['cm-sc-deciding:no']);
    expect(lineOf(container, 4)?.className).toContain('cm-sc-deciding');
  });

  it('opens a revealed line’s file and flashes the line once', () => {
    vi.useFakeTimers();
    try {
      const { container, store } = mount();
      act(() => store.getState().revealLine({ file: RELEASE, line: 9 }));
      expect(content(container).getAttribute('aria-label')).toBe(`${RELEASE}, read-only`);
      expect(lineOf(container, 9)?.className).toContain('cm-sc-flash');
      act(() => {
        vi.advanceTimersByTime(FLASH_MS);
      });
      expect(lineOf(container, 9)?.className).not.toContain('cm-sc-flash');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flash for an author who asked for less motion, nor show a reveal twice', () => {
    const query = {
      matches: true,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const matchMedia = vi.fn((q: string) => ({ ...query, media: q }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      const { container, store, unmount } = mount();
      act(() => store.getState().revealLine({ file: RELEASE, line: 9 }));
      expect(content(container).getAttribute('aria-label')).toBe(`${RELEASE}, read-only`);
      expect(classes(container).get(9)).toBeUndefined();
      expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
      unmount();
      vi.unstubAllGlobals();
      // Opened again on the same request: the line is not flashed again.
      const again = render(
        <AppProvider app={{ store } as unknown as App}>
          <YamlPane />
        </AppProvider>,
      );
      expect(classes(again.container).get(9)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws the problem lines, with a red dot and words on the tab', () => {
    const outline = structuredClone(main.outline);
    outline.files
      .find((f) => f.path === RELEASE)
      ?.errors.push({ line: 3, column: 1, message: 'Unexpected value' });
    const initial = initialSessionState();
    const { container } = mount({ ui: { ...initial.ui, yamlFile: RELEASE } }, outline);
    expect(tab('release.yml, has problems').textContent).toBe('release.yml');
    expect(tab('release.yml, has problems').querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(lineOf(container, 3)?.className).toContain('cm-sc-problem');
    expect(lineOf(container, 3)?.title).toBe('Unexpected value');
  });

  it('follows the page’s theme', () => {
    const { container } = mount();
    const theme = () => container.querySelector('.cm-editor')!.className;
    const light = theme();
    act(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    return vi.waitFor(() => expect(theme()).not.toBe(light));
  });

  it('shows the files without marks before a plan, or with a plan of other files', () => {
    const { container, unmount } = mount({ plan: undefined });
    expect(container.querySelectorAll('.cm-sc-mark')).toHaveLength(0);
    expect(content(container).getAttribute('aria-label')).toBe(`${CI}, read-only`);
    unmount();
    const stale = mount({ files: { version: 2, byPath: starter } });
    expect(stale.container.querySelectorAll('.cm-sc-mark')).toHaveLength(0);
  });

  it('closes, and leaves no editor behind', () => {
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    try {
      const { store, unmount } = mount();
      fireEvent.click(screen.getByRole('button', { name: 'Close the workflow source' }));
      expect(store.getState().ui.prefs.collapsed.yaml).toBe(true);
      expect(destroy).not.toHaveBeenCalled();
      unmount();
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      destroy.mockRestore();
    }
  });

  it('says so when no file is loaded', () => {
    const store: SessionStore = createSessionStore(initialSessionState());
    render(
      <AppProvider app={{ store } as unknown as App}>
        <YamlPane />
      </AppProvider>,
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText('No files are loaded.')).toBeTruthy();
  });
});
