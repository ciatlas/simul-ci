// @vitest-environment happy-dom
import { caseFileText, type CaseJson } from '@simulci/document';
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { sampleByName } from '../src/input/samples';
import { downloadText } from '../src/lib/download';
import {
  createSessionStore,
  dirtyPaths,
  initialSessionState,
  type PlanState,
  type SessionState,
  type Source,
} from '../src/state/store';
import { type CaseFormat, type CaseOutcome, requestCase } from '../src/testcase/case';
import { CopyAsTest } from '../src/testcase/CopyAsTest';
import type { CaseResult } from '../src/worker/client';
import { handle, initialState } from '../src/worker/handle';
import type { CaseRequest } from '../src/worker/protocol';

vi.mock('../src/lib/download', () => ({ downloadText: vi.fn() }));

/**
 * The top bar's Copy as test case and its dialog over a store holding the starter's real plan: the button waits for
 * a plan, the dialog opens on the jobs case and asks again on every format and every move of the store, only the
 * newest answer lands and names its workflow, Copy says what the clipboard did (and selects the text when it refused),
 * a failed request holds Copy and Download back, errors say the case is invalid, and Close, Escape and a plan taken
 * away tell the store. The session's testCase is a fake the test answers by hand, except once, where the worker's own
 * handler writes the case.
 */

const starter = sampleByName('starter')!.files;
const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const push: ScenarioInput = { event: 'push', branch: 'main' };
const loaded = handle(initialState(), { id: 1, type: 'load', files: starter, repository: 'o/r' });

/** A loaded project and the plan for the scenario, as the store holds them once the first plan came back. */
function ready(scenario: ScenarioInput = push): Partial<SessionState> {
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
  const planState: PlanState = {
    plan,
    derived,
    text,
    ms,
    for: { files: 1, epoch: 1, project: 1, assume: [] },
  };
  return {
    project: {
      status: 'ready',
      version: 1,
      outline: loaded.response.outline,
      files: Object.keys(starter).length,
    },
    scenario,
    plan: planState,
  };
}

/** The session's testCase, given the store's state when it is asked, as the real one reads it. */
type TestCase = (format: CaseFormat, s: SessionState, given?: unknown) => Promise<CaseOutcome>;

function mount(state: Partial<SessionState>, testCase: TestCase) {
  const store = createSessionStore({ ...initialSessionState(), focus: CI, ...state });
  const ask = vi.fn((format: CaseFormat, given?: unknown) => testCase(format, store.getState(), given));
  render(
    <AppProvider app={{ store, session: { testCase: ask } } as unknown as App}>
      <CopyAsTest />
    </AppProvider>,
  );
  return { store, ask, user: userEvent.setup() };
}

const answer = (text: string, maybes = 0): CaseOutcome => ({ type: 'case', text, maybes, errors: [] });

/** Answers the test settles by hand and in any order, one per request, each with the store's state when asked. */
function answeredByHand() {
  const pending: { format: CaseFormat; s: SessionState; resolve: (outcome: CaseOutcome) => void }[] = [];
  const testCase: TestCase = (format, s) =>
    new Promise((resolve) => {
      pending.push({ format, s, resolve });
    });
  const settle = (n: number, outcome: CaseOutcome) => act(async () => pending[n]?.resolve(outcome));
  return { pending, testCase, settle };
}

const opener = () => screen.getByRole('button', { name: 'Copy as test case' });
const dialog = () => screen.getByRole('dialog', { name: 'Copy as test case' });
const textOf = () => within(dialog()).getByRole<HTMLTextAreaElement>('textbox', { name: 'Text to copy' });
const button = (name: string) => within(dialog()).getByRole<HTMLButtonElement>('button', { name });
/** The workflow line under the title, which describes the dialog. */
const pathLine = () => document.getElementById(dialog().getAttribute('aria-describedby') ?? '')?.textContent;
const status = () => within(dialog()).getByRole('status').textContent;

/** Opens the dialog; it is in the dialogs chunk, which the first open fetches. */
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(opener());
  return screen.findByRole('dialog', { name: 'Copy as test case' });
}

/** Opens the dialog over the starter's plan with the session answering every format with the text given. */
async function openWith(outcome: CaseOutcome) {
  const mounted = mount(ready(), async () => outcome);
  await open(mounted.user);
  await waitFor(() => expect(textOf().getAttribute('aria-busy')).toBe('false'));
  return mounted;
}

describe('Copy as test case', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(downloadText).mockClear();
  });

  it('stays disabled without a plan, and opens the dialog once there is one', async () => {
    mount({}, async () => answer(''));
    expect(opener()).toHaveProperty('disabled', true);
    cleanup();

    const { store, user } = mount(ready(), async () => answer(''));
    expect(opener()).toHaveProperty('disabled', false);
    expect(screen.queryByRole('dialog')).toBeNull();
    const opened = await open(user);
    expect(store.getState().caseOpen).toBe(true);
    expect(opened.getAttribute('open')).not.toBeNull();
  });

  it('names its c key only while the page keys are on', () => {
    const { store } = mount(ready(), async () => answer(''));
    expect(opener().getAttribute('aria-keyshortcuts')).toBe('c');
    act(() => store.getState().setPrefs({ keys: false }));
    expect(opener().hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('opens on the jobs case, shows the text the session writes, and says where it belongs', async () => {
    const { ask } = await openWith(answer('cases:\n  - name: push to main\n'));
    expect(ask).toHaveBeenCalledWith('jobs', undefined);
    expect(within(dialog()).getByRole('radio', { name: 'Test case (jobs)' })).toHaveProperty('checked', true);
    expect(textOf().value).toBe('cases:\n  - name: push to main\n');
    expect(textOf().readOnly).toBe(true);
    // The focused workflow, in mono under the title, describes the dialog.
    const path = document.getElementById(dialog().getAttribute('aria-describedby') ?? '');
    expect(path?.textContent).toBe(CI);
    expect(path?.className).toContain('font-mono');
    // The destination: the workflow's test file, created, since none is loaded; adding waits for a case to add.
    const create = await within(dialog()).findByRole<HTMLButtonElement>('button', {
      name: 'Create ci.test.yml',
    });
    expect(create.disabled).toBe(true);
    expect(dialog().textContent).toContain(
      'A new .github/simulci/tests/ci.test.yml, where simulci test runs it.',
    );
    expect(button('Copy').disabled).toBe(false);
    expect(button('Download ci.test.yml').disabled).toBe(false);
    // No maybes and no errors, so no line about either.
    expect(dialog().textContent).not.toContain('maybe');
    expect(dialog().textContent).not.toContain('invalid');
  });

  it('asks again for steps and shows the newer answer even when the older one lands later', async () => {
    const { pending, testCase, settle } = answeredByHand();
    const { user } = mount(ready(), testCase);
    await open(user);
    expect(textOf().getAttribute('aria-busy')).toBe('true');
    expect(button('Copy').disabled).toBe(true);
    await settle(0, answer('jobs, first'));
    expect(textOf().value).toBe('jobs, first');

    await user.click(within(dialog()).getByRole('radio', { name: 'Test case (steps)' }));
    expect(pending.map((p) => p.format)).toEqual(['jobs', 'steps']);
    // The previous text stays while the newer one is asked for, and nothing can be copied meanwhile.
    expect(textOf().getAttribute('aria-busy')).toBe('true');
    expect(textOf().value).toBe('jobs, first');
    expect(button('Copy').disabled).toBe(true);
    expect(button('Download ci.test.yml').disabled).toBe(true);

    await user.click(within(dialog()).getByRole('radio', { name: 'Plan as text' }));
    await settle(2, answer('the plan'));
    expect(textOf().value).toBe('the plan');
    expect(textOf().getAttribute('aria-busy')).toBe('false');
    await settle(1, answer('steps, late'));
    expect(textOf().value).toBe('the plan');
    expect(dialog().textContent).toContain(
      'The plan as simulci plan prints it, every workflow the scenario reaches.',
    );
    expect(button('Download plan.txt').disabled).toBe(false);

    await user.click(within(dialog()).getByRole('radio', { name: 'Plan as Mermaid' }));
    await settle(3, answer('flowchart LR'));
    expect(dialog().textContent).toContain('The plan as simulci plan --format mermaid prints it');
    expect(button('Download plan.mmd').disabled).toBe(false);
  });

  it('asks again when Back or Forward moves the scenario and the focus, and names the workflow of the text shown', async () => {
    const { pending, testCase, settle } = answeredByHand();
    const { store, user } = mount(ready(), testCase);
    await open(user);
    await settle(0, answer('ci case'));
    // The destination comes with the edit runtime.
    await within(dialog()).findByRole('button', { name: 'Create ci.test.yml' });
    const tag: ScenarioInput = { event: 'push', tag: 'v1' };
    act(() => store.getState().setScenario(tag));
    act(() => store.getState().select(RELEASE, undefined));
    expect(pending.map((p) => [p.format, p.s.focus, p.s.scenario])).toEqual([
      ['jobs', CI, push],
      ['jobs', CI, tag],
      ['jobs', RELEASE, tag],
    ]);
    // Until the newest answer lands, the dialog still names the workflow of the text it shows.
    expect(textOf().getAttribute('aria-busy')).toBe('true');
    expect(textOf().value).toBe('ci case');
    expect(pathLine()).toBe(CI);
    expect(dialog().textContent).toContain('A new .github/simulci/tests/ci.test.yml');
    expect(button('Download ci.test.yml').disabled).toBe(true);

    await settle(2, answer('release case'));
    expect(textOf().value).toBe('release case');
    expect(pathLine()).toBe(RELEASE);
    expect(dialog().textContent).toContain('A new .github/simulci/tests/release.test.yml');
    expect(button('Download release.test.yml').disabled).toBe(false);
    // The answer for the scenario alone, landing late, changes nothing.
    await settle(1, answer('ci case under the tag'));
    expect(textOf().value).toBe('release case');
    expect(pathLine()).toBe(RELEASE);
  });

  it('copies the text and says so', async () => {
    const { user } = await openWith(answer('cases: []\n'));
    await user.click(button('Copy'));
    expect(await navigator.clipboard.readText()).toBe('cases: []\n');
    expect(status()).toBe('Copied to the clipboard.');
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });

  it('selects the whole text and offers the keys and the download when the browser refuses the clipboard', async () => {
    const { user } = await openWith(answer('cases: []\n'));
    // After user-event, which installs a clipboard of its own.
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(button('Copy'));
    expect(writeText).toHaveBeenCalledWith('cases: []\n');
    const text = textOf();
    expect(document.activeElement).toBe(text);
    expect([text.selectionStart, text.selectionEnd]).toEqual([0, 'cases: []\n'.length]);
    const alert = within(dialog()).getByRole('alert').textContent ?? '';
    expect(alert).toMatch(/^The browser refused the clipboard/);
    expect(alert).toContain('The text is selected: press Ctrl+C or ⌘C, or download it.');
    expect(status()).toBe('');
  });

  it('empties the status while each Copy works, so a second Copied is announced again', async () => {
    const { user } = await openWith(answer('cases: []\n'));
    let written = (): void => undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          written = resolve;
        }),
    );
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    for (const round of [1, 2]) {
      await user.click(button('Copy'));
      expect(writeText).toHaveBeenCalledTimes(round);
      expect(status()).toBe('');
      await act(async () => written());
      expect(status()).toBe('Copied to the clipboard.');
    }
  });

  it('shows why a request failed and holds Copy and Download back', async () => {
    await openWith({ type: 'failed', message: 'the files were loaded again; try again' });
    expect(within(dialog()).getByRole('alert').textContent).toContain(
      'the files were loaded again; try again',
    );
    expect(button('Copy').disabled).toBe(true);
    expect(button('Download ci.test.yml').disabled).toBe(true);
  });

  it('lists the errors `simulci test` would report the case invalid for, and still offers the text', async () => {
    const errors = [
      'SC102 assume[0] matches nothing in this plan',
      'SC103 assume[1] and assume[2] both set outcome of build.detect to different values',
    ];
    await openWith({ type: 'case', text: 'cases: []\n', maybes: 0, errors });
    expect(dialog().textContent).toContain('simulci test would report this case invalid:');
    const items = within(dialog()).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(errors);
    expect(button('Copy').disabled).toBe(false);
    expect(button('Download ci.test.yml').disabled).toBe(false);
  });

  it('downloads the text under the name and the type of its format', async () => {
    const { user } = await openWith(answer('cases: []\n'));
    await user.click(button('Download ci.test.yml'));
    expect(downloadText).toHaveBeenCalledWith('ci.test.yml', 'cases: []\n', 'application/yaml');
    await user.click(within(dialog()).getByRole('radio', { name: 'Plan as text' }));
    await waitFor(() => expect(button('Download plan.txt').disabled).toBe(false));
    await user.click(button('Download plan.txt'));
    expect(downloadText).toHaveBeenLastCalledWith('plan.txt', 'cases: []\n', 'text/plain');
  });

  it('tells the store when Close or Escape closes it', async () => {
    const { store, user } = await openWith(answer('cases: []\n'));
    await user.click(button('Close'));
    expect(store.getState().caseOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();

    const reopened = await open(user);
    expect(store.getState().caseOpen).toBe(true);
    // Escape cancels a modal dialog, which closes it: the same close event.
    act(() => (reopened as HTMLDialogElement).close());
    expect(store.getState().caseOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when files dropped behind it take the plan away, and stays closed once a plan is back', async () => {
    const { store } = await openWith(answer('cases: []\n'));
    act(() => store.getState().setFiles(starter, { kind: 'folder', name: 'repo', readAt: 0 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(store.getState().caseOpen).toBe(false);
    expect(opener()).toHaveProperty('disabled', true);
    // The dropped files loaded and simulated: the button is back, the dialog waits for it.
    act(() => store.setState(ready()));
    expect(opener()).toHaveProperty('disabled', false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open while the same files load again, and asks again once they are loaded', async () => {
    const { store, ask } = await openWith(answer('cases: []\n'));
    // A stale reply makes the session load the same files again: the plan stays while the project loads.
    act(() => store.getState().projectLoading());
    expect(dialog()).toBeTruthy();
    act(() => store.getState().projectReady(2, store.getState().project.outline!, 1));
    expect(dialog()).toBeTruthy();
    // Once when it opened, once for the project the files were loaded again as.
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('forgets what Copy said once the text is asked for again', async () => {
    const { store, user } = await openWith(answer('cases: []\n'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
    await user.click(button('Copy'));
    expect(status()).toBe('Copied to the clipboard.');
    act(() => store.getState().setScenario({ event: 'push', branch: 'next' }));
    expect(status()).toBe('');
  });

  it('counts the maybes in words: what they are written as, and that allowMaybe lets the case pass', async () => {
    await openWith(answer('cases: []\n', 2));
    expect(dialog().textContent).toContain(
      '2 maybes are written as comments naming the unknown and the pin that decides it, or why none does; ' +
        'allowMaybe: true lets the case pass while they stay open.',
    );
  });

  it('shows the case the worker writes for the starter, its maybe a comment, and the line about it', async () => {
    const client = {
      case: async (body: Omit<CaseRequest, 'id' | 'type'>) =>
        handle(loaded.state, { ...body, id: 3, type: 'case' }).response as CaseResult,
    };
    const { ask, user } = mount(ready(), (format, s) => requestCase(client, s, format));
    await open(user);
    await waitFor(() => expect(textOf().getAttribute('aria-busy')).toBe('false'));
    expect(ask).toHaveBeenCalledOnce();
    // Push to main says nothing about the changed files, so whether the workflow runs is a maybe.
    expect(textOf().value).toContain('# ci.yml: maybe — scenario.changed → pin: ');
    expect(textOf().value).toContain('allowMaybe: true');
    expect(dialog().textContent).toContain(
      '1 maybe is written as a comment naming the unknown and the pin that decides it, or why none does; ' +
        'allowMaybe: true lets the case pass while it stays open.',
    );
  });
});

describe('Add it to the repository', () => {
  afterEach(() => cleanup());

  const TEST = '.github/simulci/tests/ci.test.yml';
  const PUSH: CaseJson = {
    name: 'push to main',
    when: { event: 'push', branch: 'main' },
    then: { run: ['build', 'deploy'] },
    comments: [],
  };
  const withCase = (testCase: CaseJson = PUSH): CaseOutcome => ({
    type: 'case',
    text: 'workflow: ci.yml\n',
    maybes: 0,
    errors: [],
    case: testCase,
  });
  const FOLDER: Source = { kind: 'folder', name: 'repo', readAt: 0 };

  /** The starter in a folder with these route tests, its plan on screen, and the dialog open on a case to add. */
  async function openRepo(tests: Record<string, string>, testCase: TestCase = async () => withCase()) {
    const mounted = mount({}, testCase);
    act(() => {
      mounted.store.getState().setFiles({ ...starter, ...tests }, FOLDER);
      mounted.store.setState({ ...ready(), focus: CI, generated: {} });
    });
    await open(mounted.user);
    return mounted;
  }

  /** The destination's button once the edit runtime is in and the case is there to add. */
  async function adder(name: string): Promise<HTMLButtonElement> {
    const found = await within(dialog()).findByRole<HTMLButtonElement>('button', { name });
    await waitFor(() => expect(found.disabled).toBe(false));
    return found;
  }

  it('adds the case to the workflow’s test file as one entry, then shows it in the pane, unsaved', async () => {
    const before =
      'workflow: ci.yml\ncases:\n  - name: a pull request\n    when: { event: pull_request }\n    then: { run: [build] }\n';
    const { store, user } = await openRepo({ [TEST]: before });
    const add = await adder('Add to ci.test.yml');
    expect(dialog().textContent).toContain(
      'Into .github/simulci/tests/ci.test.yml (1 case), where simulci test runs it. It stays unsaved until you download it.',
    );
    await user.click(add);
    const s = store.getState();
    expect(s.files.byPath[TEST]).toBe(
      `${before}  - name: push to main\n    when: { event: push, branch: main }\n    then:\n      run: [build, deploy]\n`,
    );
    expect(s.edit.past.at(-1)!.label).toBe("Added test case 'push to main'");
    expect(dirtyPaths(s.files)).toEqual([TEST]);
    // Shown: edit mode, the pane on the case, a notice with Undo; the dialog is closed.
    expect(s.edit.on).toBe(true);
    expect(s.reveal).toMatchObject({ file: TEST, line: 6 });
    expect(s.ui.yamlFile).toBe(TEST);
    expect(s.notices.at(-1)).toMatchObject({ text: "Added test case 'push to main' to ci.test.yml" });
    expect(s.notices.at(-1)!.undo).toBe(s.edit.past.at(-1));
    expect(s.caseOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().files.byPath[TEST]).toBe(before);
  });

  it('creates the test file when none is loaded, in the workflow’s line endings, and an undo removes it', async () => {
    const { store, user } = await openRepo({});
    await user.click(await adder('Create ci.test.yml'));
    const s = store.getState();
    expect(s.files.byPath[TEST]).toBe(caseFileText(TEST, 'ci.yml', PUSH, '\n'));
    // A file the folder does not have: Save writes it as a create.
    expect(s.files.base).not.toHaveProperty(TEST);
    expect(s.edit.past.at(-1)!.label).toBe("Added test case 'push to main'");
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().files.byPath).not.toHaveProperty(TEST);
    expect(dirtyPaths(store.getState().files)).toEqual([]);

    cleanup();
    const crlf = Object.fromEntries(Object.entries(starter).map(([p, t]) => [p, t.replaceAll('\n', '\r\n')]));
    const again = mount({}, async () => withCase());
    act(() => {
      again.store.getState().setFiles(crlf, FOLDER);
      again.store.setState({ ...ready(), focus: CI, generated: {} });
    });
    await open(again.user);
    await again.user.click(await adder('Create ci.test.yml'));
    expect(again.store.getState().files.byPath[TEST]).toBe(caseFileText(TEST, 'ci.yml', PUSH, '\r\n'));
  });

  it('writes the name the author gives, says when the file has it, and adds nothing without one', async () => {
    const before =
      'workflow: ci.yml\ncases:\n  - name: push to main\n    when: { event: push }\n    then: { run: [build] }\n';
    const { store, user } = await openRepo({ [TEST]: before });
    const add = await adder('Add to ci.test.yml');
    const field = within(dialog()).getByRole<HTMLInputElement>('textbox', { name: 'Case name' });
    expect(field.value).toBe('push to main');
    expect(dialog().textContent).toContain(
      'ci.test.yml has a case by that name: this one is added as push to main (2).',
    );
    await user.clear(field);
    expect(add.disabled).toBe(true);
    await user.type(field, 'a push to main deploys');
    expect(dialog().textContent).not.toContain('has a case by that name');
    await user.click(add);
    const cases = store.getState().files.byPath[TEST]!;
    expect(cases).toContain('  - name: a push to main deploys\n');
    expect(store.getState().edit.past.at(-1)!.label).toBe("Added test case 'a push to main deploys'");
  });

  it('refuses a file that tests another workflow, and its fix writes the case beside it', async () => {
    const before =
      'workflow: release.yml\ncases:\n  - { name: x, when: { event: push }, then: { run: [] } }\n';
    const { store, user } = await openRepo({ [TEST]: before });
    await user.click(await adder('Add to ci.test.yml'));
    expect(dialog().textContent).toContain('ci.test.yml tests release.yml.');
    expect(store.getState().files.byPath[TEST]).toBe(before);
    await user.click(within(dialog()).getByRole('button', { name: 'Create ci-2.test.yml' }));
    const s = store.getState();
    const beside = '.github/simulci/tests/ci-2.test.yml';
    expect(s.files.byPath[beside]).toBe(caseFileText(beside, 'ci.yml', PUSH, '\n'));
    expect(s.files.byPath[TEST]).toBe(before);
    expect(s.edit.past.at(-1)!.label).toBe("Added test case 'push to main'");
    expect(s.reveal).toMatchObject({ file: beside });
    expect(s.notices.at(-1)).toMatchObject({ text: "Added test case 'push to main' to ci-2.test.yml" });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for the case under the given of the file it goes to, and says so', async () => {
    const before =
      'workflow: ci.yml\ngiven: { changed: [src/a.ts] }\ncases:\n  - { name: x, when: { event: push }, then: { run: [build] } }\n';
    const { ask, user } = await openRepo({ [TEST]: before });
    await adder('Add to ci.test.yml');
    expect(ask.mock.calls).toEqual([
      ['jobs', undefined],
      ['jobs', { changed: ['src/a.ts'] }],
    ]);
    expect(dialog().textContent).toContain(
      "where simulci test runs it with the file's given, which the case above is planned under.",
    );
    // The plan formats are no case for the file.
    await user.click(within(dialog()).getByRole('radio', { name: 'Plan as text' }));
    expect(ask.mock.lastCall).toEqual(['text', undefined]);
  });

  it('says a folder with a handle saves the file, and waits for a case to add', async () => {
    const { pending, testCase, settle } = answeredByHand();
    const mounted = mount({}, testCase);
    act(() => {
      mounted.store.getState().setFiles(starter, { ...FOLDER, handle: {} as FileSystemDirectoryHandle });
      mounted.store.setState({ ...ready(), focus: CI, generated: {} });
    });
    await open(mounted.user);
    const create = await within(dialog()).findByRole<HTMLButtonElement>('button', {
      name: 'Create ci.test.yml',
    });
    expect(dialog().textContent).toContain('It stays unsaved until you save it to the folder.');
    expect(create.disabled).toBe(true);
    await settle(0, withCase());
    expect(create.disabled).toBe(false);
    expect(pending).toHaveLength(1);
  });
});
