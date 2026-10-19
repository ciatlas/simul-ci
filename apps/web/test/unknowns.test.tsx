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
 * the editor writes an assume entry (or edits the one already there), the next plan shows it among the Assumptions
 * where it applied, a refusal shows on its entry (before the first plan too), an entry's editor follows it when
 * another goes, and the toggle keeps what affects the selection. Then the PinEditor on its own: its chips' names,
 * its problems announced and on their fields, the focus when a preset is cleared, the held value's placeholder.
 */

const starter = sampleByName('starter')!.files;
const CI = '.github/workflows/ci.yml';
const push: ScenarioInput = { event: 'push', branch: 'main' };
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
  return { plan, derived, text, ms, for: { files: 1, project: 1, assume } };
}

function mount(scenario: ScenarioInput, assume: AssumeEntry[] = [], sel?: string) {
  return mountState({ scenario, assume, plan: planState(scenario, assume), sel });
}

function mountState(state: Partial<SessionState>) {
  const store = createSessionStore({ ...initialSessionState(), focus: CI, ...state });
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
    expect(store.getState().stale).toBe(true);
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
