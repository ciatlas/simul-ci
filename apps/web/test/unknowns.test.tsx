// @vitest-environment happy-dom
import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { sampleByName } from '../src/input/samples';
import type { PinDraft } from '../src/panels/pin-draft';
import { PinEditor } from '../src/panels/PinEditor';
import { Unknowns } from '../src/panels/Unknowns';
import {
  createSessionStore,
  initialSessionState,
  type PlanState,
  type SessionState,
} from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

/**
 * The Unknowns tab over the starter's real plans: a scenario pin writes the scenario and asks the form for the field,
 * the editor writes an assume entry as a pin (or edits the one already there), the next plan shows it among the
 * Assumptions where it applied and moves the focus off the row it dropped, a refusal shows on its entry (before the
 * first plan too), an entry's editor follows it when another goes, and the toggle keeps what affects the selection.
 * "affects n" holds the hovered unknown while the pointer or the keyboard focus is on it, a reason's "Show … in
 * Unknowns" puts the focus on the row, whatever hid it, and a row is focusable only for the focus the tab puts there. Then the PinEditor on its own: its chips' names, its problems
 * announced and on their fields, the focus when a preset is cleared, the held value's placeholder.
 */

const starter = sampleByName('starter')!.files;
const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const DETECT = `${CI}#build/steps.detect.outputs.changed`;
const push: ScenarioInput = { event: 'push', branch: 'main' };
/** A tag push runs the release, whose composite's cache leaves two unknowns that decide no verdict. */
const tag: ScenarioInput = { event: 'push', tag: 'v1' };
const CACHE = `${RELEASE}#publish/~github-actions-setup>.github/actions/setup/steps.cache`;
const source: ScenarioInput = { ...push, changed: ['src/index.ts'] };
const detect: AssumeEntry = { step: 'build.detect', outputs: { changed: 'true' } };

function planState(scenario: ScenarioInput, assume: AssumeEntry[] = []): PlanState {
  const loaded = handle(initialState(), { id: 1, type: 'load', files: starter, repository: 'o/r' });
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume,
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  const { plan, derived, text, ms } = step.response;
  return { plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1, assume, scenario } };
}

function mount(scenario: ScenarioInput, assume: AssumeEntry[] = [], sel?: string, focus = CI) {
  return mountState({ scenario, assume, plan: planState(scenario, assume), sel, focus });
}

/** The tab over a store in `state`; `before` acts on the store before the tab mounts. */
function mountState(
  state: Partial<SessionState>,
  before?: (store: ReturnType<typeof createSessionStore>) => void,
) {
  const store = createSessionStore({ ...initialSessionState(), focus: CI, ...state });
  before?.(store);
  render(
    <AppProvider app={{ store } as unknown as App}>
      <Unknowns />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

const gating = () => screen.getByRole('list', { name: 'Unknowns that decide a verdict' });
const rowOf = (path: string, list = gating()) =>
  within(list)
    .getAllByRole('listitem')
    .find((li) => li.querySelector('code')?.textContent === path)!;
const assumptionsRegion = () => screen.getByRole('region', { name: 'Assumptions' });
/** The Assumptions item whose label is `label`. */
const itemOf = (label: string) =>
  within(assumptionsRegion())
    .getAllByRole('listitem')
    .find((li) => li.querySelector('.font-mono')?.textContent === label)!;
const PENDING = 'where it applies shows with the next plan';
/** A row by its unknown's id (`data-unknown`), wherever it is, the collapsed rest too. */
const rowById = (id: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-unknown]')).find(
    (el) => el.dataset.unknown === id,
  );
const idleDetails = () => screen.getByText(/that decides? no verdict$/).closest('details')!;
const countOf = (path: string) => within(rowOf(path)).getByRole('button', { name: /^affects \d+:/ });

/**
 * What the browser says of `:hover` and `:focus-visible` on `el`, which happy-dom cannot tell: it never matches
 * `:hover`, and matches `:focus-visible` for any focus. The test says whether the pointer is over the element and
 * whether its focus came from the keyboard; every other selector is matched as happy-dom does.
 */
function pseudoClasses(el: HTMLElement): { hover: boolean; keyboard: boolean } {
  const state = { hover: false, keyboard: true };
  const matches = el.matches.bind(el);
  vi.spyOn(el, 'matches').mockImplementation((selector) => {
    if (selector === ':hover') return state.hover;
    if (selector === ':focus-visible') return state.keyboard && document.activeElement === el;
    return matches(selector);
  });
  return state;
}

describe('the Unknowns tab', () => {
  afterEach(cleanup);

  it('pins a scenario unknown with the fragment it carries, marks it assumed and asks the form for the field', async () => {
    const { store, user } = mount(push);
    await user.click(within(rowOf('scenario.changed')).getByRole('button', { name: 'Set changed files' }));
    const s = store.getState();
    expect(s.scenario).toEqual({ ...push, changed: ['docs/**'] });
    expect(s.assumed).toContain('changed');
    expect(s.fieldFocus).toMatchObject({ path: 'changed' });
  });

  it('writes the entry the editor builds for a step output, and shows it applied once the next plan has it', async () => {
    const { store, user } = mount(source);
    await user.click(within(rowOf('build.detect.outputs.changed')).getByRole('button', { name: 'Pin…' }));
    const editor = screen.getByRole('form', { name: /^Pin build\.detect/ });
    expect(within(editor).getByLabelText('Value of changed')).toBe(document.activeElement);
    await user.keyboard('true');
    await user.click(within(editor).getByRole('button', { name: 'Apply' }));
    expect(store.getState().assume).toEqual([detect]);
    // A pin, which the status line answers once the plan for exactly these inputs comes.
    expect(store.getState().change?.waitFor.assume).toBe(store.getState().assume);

    act(() => store.getState().planReceived(planState(source, store.getState().assume)));
    const assumptions = screen.getByRole('region', { name: 'Assumptions' });
    expect(assumptions.textContent).toContain('build.detect · outputs.changed = true');
    expect(assumptions.textContent).toContain('applied at build.detect');
    expect(screen.queryByRole('form')).toBeNull();
    // The output is known now: it decides no verdict any more, so it waits among the collapsed rest.
    const decide = screen.queryByRole('list', { name: 'Unknowns that decide a verdict' });
    expect(decide?.textContent ?? '').not.toContain('build.detect.outputs.changed');
  });

  it('removes an assumption, and shows the worker’s refusal on the entry it names', async () => {
    const { store, user } = mount(source, [detect]);
    act(() =>
      store.getState().rejected({
        kind: 'assume',
        message: 'bad',
        issues: [{ path: [0, 'outputs'], message: 'expected a record' }],
      }),
    );
    const assumptions = screen.getByRole('region', { name: 'Assumptions' });
    expect(assumptions.textContent).toContain('outputs: expected a record');
    await user.click(within(assumptions).getByRole('button', { name: /^Remove / }));
    expect(store.getState().assume).toEqual([]);
    // The Assumptions list edits the case layer; it pins nothing.
    expect(store.getState().change).toBeUndefined();
  });

  it('edits the entry a step output already has when Pin… opens on it again, so no second entry conflicts', async () => {
    const held: AssumeEntry = { step: 'build.detect', outputs: { changed: { unknown: true } } };
    const { store, user } = mount(source, [held]);
    // The entry holds the output unknown, so its row stays, still with Pin….
    await user.click(within(rowOf('build.detect.outputs.changed')).getByRole('button', { name: 'Pin…' }));
    const value = within(screen.getByRole('form', { name: /^Pin build\.detect/ })).getByLabelText(
      'Value of changed',
    );
    expect(value.getAttribute('placeholder')).toBe('unknown');
    await user.clear(value);
    await user.type(value, 'false');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(store.getState().assume).toEqual([{ step: 'build.detect', outputs: { changed: 'false' } }]);
  });

  it('keeps an entry’s editor and its draft with the entry when an earlier one goes, and says nothing stale', async () => {
    const build: AssumeEntry = { job: 'build', outcome: 'success' };
    const deploy: AssumeEntry = { job: 'deploy', outcome: 'success' };
    const { store, user } = mount(source, [build, detect, deploy]);
    const label = 'build.detect · outputs.changed = true';
    expect(itemOf(label).textContent).toContain('applied at build.detect');
    await user.click(screen.getByRole('button', { name: `Edit ${label}` }));
    const value = within(itemOf(label)).getByLabelText('Value of changed');
    await user.clear(value);
    await user.type(value, 'false');
    await user.click(screen.getByRole('button', { name: 'Remove build · outcome success' }));

    expect(store.getState().assume).toEqual([detect, deploy]);
    const [editor, ...more] = screen.getAllByRole('form');
    expect(more).toHaveLength(0);
    expect(editor?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(itemOf(label).contains(editor!)).toBe(true);
    expect(within(editor!).getByLabelText('Value of changed')).toHaveProperty('value', 'false');
    // The plan in hand was simulated with the old list: its assume[0] is the entry that went.
    expect(assumptionsRegion().textContent).not.toContain('applied at');
    expect(itemOf(label).textContent).toContain(PENDING);

    // Applied, the edit takes the entry's place, and the focus stays on its Edit button.
    await user.click(within(editor!).getByRole('button', { name: 'Apply' }));
    const edited = { step: 'build.detect', outputs: { changed: 'false' } };
    expect(store.getState().assume).toEqual([edited, deploy]);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Edit build.detect · outputs.changed = false' }),
    );
    act(() => store.getState().planReceived(planState(source, store.getState().assume)));
    expect(itemOf('build.detect · outputs.changed = false').textContent).toContain('applied at build.detect');
    expect(itemOf('deploy · outcome success').textContent).toContain('applied at deploy');
  });

  it('keeps saying where an entry applied while only the scenario changes', () => {
    const { store } = mount(source, [detect]);
    act(() => store.getState().patchScenario({ message: 'docs' }));
    expect(store.getState().stale).toBe('inputs');
    expect(itemOf('build.detect · outputs.changed = true').textContent).toContain('applied at build.detect');
  });

  it('shows an entry the worker refused before the first plan, and removes it', async () => {
    const { store, user } = mountState({
      scenario: source,
      assume: [{ step: 'build.detect' }],
      error: {
        kind: 'assume',
        message: 'state an outcome, outputs, env or as',
        issues: [{ path: [0], message: 'state an outcome, outputs, env or as' }],
      },
    });
    const item = itemOf('build.detect');
    expect(item.textContent).toContain('state an outcome, outputs, env or as');
    expect(item.textContent).toContain(PENDING);
    expect(screen.getByText('The unknowns show with the first plan.')).toBeTruthy();
    // Editing needs a plan to decide against; removing does not.
    expect(within(item).queryByRole('button', { name: /^Edit / })).toBeNull();
    await user.click(within(item).getByRole('button', { name: 'Remove build.detect' }));
    expect(store.getState().assume).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Assumptions' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Unknowns' }));
  });

  it('keeps the unknowns that affect the selection when the author asks, and offers no toggle for the workflow', async () => {
    const { user } = mount(push, [], 'build');
    const paths = () =>
      within(gating())
        .getAllByRole('listitem')
        .map((li) => li.querySelector('code')?.textContent);
    expect(paths()).toHaveLength(2);
    await user.click(screen.getByRole('checkbox', { name: /affecting/ }));
    // The changed files decide the workflow above build, the step output a step of build.
    expect(paths()).toEqual(['build.detect.outputs.changed']);
    cleanup();
    mount(push);
    expect(screen.queryByRole('checkbox', { name: /affecting/ })).toBeNull();
  });
});

describe('the focus and the hover in the Unknowns tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('moves the focus to the next row once the plan a pin brought drops the pinned one, and dims no card', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { store, user } = mount(push);
    await user.click(within(rowOf('build.detect.outputs.changed')).getByRole('button', { name: 'Pin…' }));
    await user.keyboard('true');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const s = store.getState();
    act(() => s.planReceived(planState(s.scenario, s.assume)));
    expect(rowById(DETECT)).toBeUndefined();
    // The row, not its affects n, whose focus would dim the canvas over the cards the pin flashed.
    const next = rowById('scenario.changed')!;
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute('tabindex')).toBe('-1');
    expect(scroll.mock.contexts).toContain(next);
    expect(store.getState().hoveredUnknown).toBeUndefined();
  });

  it('makes a row focusable only for the focus the tab puts there, so a click on its text rings nothing', async () => {
    const { store, user } = mount(push);
    const row = rowById(DETECT)!;
    expect(row.hasAttribute('tabindex')).toBe(false);
    await user.click(row.querySelector('code')!);
    expect(document.activeElement).toBe(document.body);

    act(() => store.getState().showUnknown(DETECT));
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('tabindex')).toBe('-1');
    // Once the focus leaves, the row is plain again, and a click on its text leaves the focus nowhere.
    await user.click(rowById('scenario.changed')!.querySelector('code')!);
    expect(document.activeElement).toBe(document.body);
    expect(row.hasAttribute('tabindex')).toBe(false);
    await user.click(row.querySelector('code')!);
    expect(document.activeElement).toBe(document.body);
  });

  it('holds the hovered unknown while the pointer or the focus is on affects n, and lets go of it after', async () => {
    const { store, user } = mount(push);
    const count = countOf('build.detect.outputs.changed');
    await user.hover(count);
    expect(store.getState().hoveredUnknown).toBe(DETECT);
    await user.unhover(count);
    expect(store.getState().hoveredUnknown).toBeUndefined();

    act(() => count.focus());
    expect(store.getState().hoveredUnknown).toBe(DETECT);
    act(() => count.blur());
    expect(store.getState().hoveredUnknown).toBeUndefined();

    // Leaving one count while the store holds another leaves that one alone.
    await user.hover(count);
    act(() => store.getState().hoverUnknown('scenario.changed'));
    await user.unhover(count);
    expect(store.getState().hoveredUnknown).toBe('scenario.changed');
  });

  it('keeps the dim the keyboard focus holds while the pointer passes off the count, and the pointer’s while the focus leaves', async () => {
    const { store, user } = mount(push);
    const count = countOf('build.detect.outputs.changed');
    const at = pseudoClasses(count);
    act(() => count.focus());
    at.hover = true;
    await user.hover(count);
    at.hover = false;
    await user.unhover(count);
    expect(store.getState().hoveredUnknown).toBe(DETECT);
    act(() => count.blur());
    expect(store.getState().hoveredUnknown).toBeUndefined();

    at.hover = true;
    await user.hover(count);
    act(() => count.focus());
    act(() => count.blur());
    expect(store.getState().hoveredUnknown).toBe(DETECT);
    at.hover = false;
    await user.unhover(count);
    expect(store.getState().hoveredUnknown).toBeUndefined();
  });

  it('lets go of the dim when the pointer leaves a count a click left the focus on', async () => {
    const { store, user } = mount(push);
    const count = countOf('build.detect.outputs.changed');
    const at = pseudoClasses(count);
    at.keyboard = false;
    at.hover = true;
    await user.click(count);
    expect(document.activeElement).toBe(count);
    expect(store.getState().hoveredUnknown).toBe(DETECT);
    at.hover = false;
    await user.unhover(count);
    expect(store.getState().hoveredUnknown).toBeUndefined();
  });

  it('lets go of the hovered unknown when its row goes with the plan a pin brought', async () => {
    const { store, user } = mount(source);
    await user.hover(countOf('build.detect.outputs.changed'));
    expect(store.getState().hoveredUnknown).toBe(DETECT);
    act(() => store.getState().pinAssume([detect]));
    const s = store.getState();
    act(() => s.planReceived(planState(s.scenario, s.assume)));
    expect(rowById(DETECT)).toBeUndefined();
    expect(store.getState().hoveredUnknown).toBeUndefined();
  });

  it('puts the focus on the row a reason asks for, scrolled into view at once, and takes the request', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { store } = mount(push);
    act(() => store.getState().showUnknown('scenario.changed'));
    const row = rowById('scenario.changed')!;
    expect(row.tagName).toBe('LI');
    expect(row.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(row);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
    expect(scroll.mock.contexts).toContain(row);
    expect(store.getState().unknownFocus).toBeUndefined();
  });

  it('answers a request made before the tab mounted, as when the panel was closed', () => {
    const { store } = mountState({ scenario: push, plan: planState(push) }, (s) =>
      s.getState().showUnknown(DETECT),
    );
    expect(document.activeElement).toBe(rowById(DETECT));
    expect(store.getState().unknownFocus).toBeUndefined();
  });

  it('opens the collapsed rest for a row that decides no verdict', () => {
    const { store } = mount(tag, [], undefined, RELEASE);
    expect(idleDetails().open).toBe(false);
    act(() => store.getState().showUnknown(`${CACHE}.outputs.cache-matched-key`));
    expect(idleDetails().open).toBe(true);
    expect(document.activeElement).toBe(rowById(`${CACHE}.outputs.cache-matched-key`));
    expect(store.getState().unknownFocus).toBeUndefined();
  });

  it('turns the toggle off and opens the collapsed rest for a row the toggle hides that decides no verdict', async () => {
    const { store, user } = mount(tag, [], 'publish', RELEASE);
    await user.click(screen.getByRole('checkbox', { name: /affecting/ }));
    const hashFiles = "expression:deps-${{ hashFiles('package-lock.json') }}";
    expect(rowById(hashFiles)).toBeUndefined();
    act(() => store.getState().showUnknown(hashFiles));
    expect(screen.getByRole('checkbox', { name: /affecting/ })).toHaveProperty('checked', false);
    expect(idleDetails().open).toBe(true);
    expect(document.activeElement).toBe(rowById(hashFiles));
  });

  it('turns the toggle off for a row that decides a verdict but not about the selection', async () => {
    const { store, user } = mount(push, [], 'build');
    await user.click(screen.getByRole('checkbox', { name: /affecting/ }));
    expect(rowById('scenario.changed')).toBeUndefined();
    act(() => store.getState().showUnknown('scenario.changed'));
    expect(screen.getByRole('checkbox', { name: /affecting/ })).toHaveProperty('checked', false);
    expect(document.activeElement).toBe(rowById('scenario.changed'));
  });

  it('puts the focus on the heading for an unknown the plan does not list, or before the first plan, and takes the request', () => {
    const { store } = mount(source);
    act(() => store.getState().showUnknown('scenario.changed'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Unknowns' }));
    expect(store.getState().unknownFocus).toBeUndefined();
    cleanup();

    const before = mountState({ scenario: source });
    act(() => before.store.getState().showUnknown(DETECT));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Unknowns' }));
    expect(before.store.getState().unknownFocus).toBeUndefined();
  });
});

describe('the PinEditor', () => {
  afterEach(cleanup);

  const output = (entry: AssumeEntry, name: string, candidates: string[] = []): PinDraft => ({
    entry,
    about: { field: 'outputs', name },
    outcomes: ['success', 'failure'],
    candidates,
  });

  function editor(draft: PinDraft) {
    const onApply = vi.fn();
    render(<PinEditor draft={draft} onApply={onApply} onCancel={() => {}} />);
    return { onApply, user: userEvent.setup() };
  }

  it('names the empty-string candidate by what it shows', () => {
    editor(output({ step: 'build.cache', outputs: { 'cache-hit': '' } }, 'cache-hit', ['true', 'false', '']));
    const group = screen.getByRole('group', { name: 'Values cache-hit can take' });
    expect(within(group).queryAllByRole('button', { name: '' })).toEqual([]);
    const empty = within(group).getByRole('button', { name: "'' (empty)" });
    expect(empty.getAttribute('aria-pressed')).toBe('true');
  });

  it('announces what is wrong, marks the row it is about, and holds Apply back until it is right', async () => {
    const { onApply, user } = editor(output({ step: 'build.detect', outputs: { changed: '' } }, 'changed'));
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    await user.click(screen.getByRole('button', { name: 'Add output' }));
    await user.type(screen.getByLabelText('Value of output 2'), 'x');

    const name = screen.getByLabelText('Name of output 2');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const said = document.getElementById(name.getAttribute('aria-describedby') ?? '');
    expect(said?.textContent).toBe('output 2 has a value but no name');
    expect(status.contains(said)).toBe(true);
    expect(screen.getByRole('form').getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByLabelText('Name of output 1').getAttribute('aria-invalid')).toBeNull();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    expect(apply.getAttribute('aria-describedby')).toBe(status.id);
    await user.click(apply);
    expect(onApply).not.toHaveBeenCalled();

    await user.type(name, 'other');
    expect(name.getAttribute('aria-invalid')).toBeNull();
    expect(status.textContent).toBe('');
    expect(apply.getAttribute('aria-disabled')).toBe('false');
    await user.click(apply);
    expect(onApply).toHaveBeenCalledWith({ step: 'build.detect', outputs: { changed: '', other: 'x' } });
  });

  it('puts the focus on a control that stays when Clear as: takes itself away', async () => {
    const pinned: PinDraft = {
      entry: { step: 'build.detect', as: 'hit' },
      about: { field: 'outcome' },
      outcomes: ['success', 'failure'],
      candidates: [],
    };
    const { user } = editor(pinned);
    await user.click(screen.getByRole('button', { name: 'Clear as:' }));
    expect(screen.queryByRole('button', { name: 'Clear as:' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'none' }));
    cleanup();

    const { user: again } = editor({ ...pinned, model: { id: 'actions/cache', presets: ['hit', 'miss'] } });
    await again.click(screen.getByRole('button', { name: 'Clear as:' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'hit' }));
  });

  it('draws the placeholder of a value held unknown in the muted colour', () => {
    editor(output({ step: 'build.detect', outputs: { changed: { unknown: true } } }, 'changed'));
    const value = screen.getByLabelText('Value of changed');
    expect(value.getAttribute('placeholder')).toBe('unknown');
    expect(value.className.split(' ')).toContain('placeholder:text-muted');
  });
});
