// @vitest-environment happy-dom
import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { sampleByName } from '../src/input/samples';
import { Unknowns } from '../src/panels/Unknowns';
import { createSessionStore, initialSessionState, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

/**
 * The Unknowns tab over the starter's real plans: a scenario pin writes the scenario and asks the form for the field,
 * the editor writes an assume entry, the next plan shows it among the Assumptions where it applied, a refusal shows
 * on its entry, and the toggle keeps what affects the selection.
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
  return { plan, derived, text, ms, for: { files: 1, project: 1 } };
}

function mount(scenario: ScenarioInput, assume: AssumeEntry[] = [], sel?: string) {
  const store = createSessionStore({
    ...initialSessionState(),
    scenario,
    assume,
    plan: planState(scenario, assume),
    focus: CI,
    sel,
  });
  render(
    <AppProvider app={{ store } as unknown as App}>
      <Unknowns />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

const gating = () => screen.getByRole('list', { name: 'Unknowns that decide a verdict' });
const rowOf = (path: string) =>
  within(gating())
    .getAllByRole('listitem')
    .find((li) => li.querySelector('code')?.textContent === path)!;

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

    act(() => store.getState().planReceived(planState(source, [detect])));
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

  it('keeps the unknowns that affect the selection when the author asks, and offers no toggle for the workflow', async () => {
    const { user } = mount(push, [], 'deploy');
    const paths = () =>
      within(gating())
        .getAllByRole('listitem')
        .map((li) => li.querySelector('code')?.textContent);
    expect(paths()).toHaveLength(3);
    await user.click(screen.getByRole('checkbox', { name: /affecting/ }));
    // The changed files decide the workflow above deploy, the step output a step of build: neither is deploy's.
    expect(paths()).toEqual(['expression:success()']);
    cleanup();
    mount(push);
    expect(screen.queryByRole('checkbox', { name: /affecting/ })).toBeNull();
  });
});
