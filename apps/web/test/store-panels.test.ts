import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { createSessionStore, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const starter = sampleByName('starter')!.files;
const source: ScenarioInput = { event: 'push', branch: 'main', changed: ['src/index.ts'] };
const detect: AssumeEntry = { step: 'build.detect', outputs: { changed: 'true' } };

/** The starter's plan for these inputs, as the session receives it: `for` names the very objects it was given. */
function planState(scenario: ScenarioInput, assume: AssumeEntry[] = []): PlanState {
  const loaded = handle(initialState(), { id: 1, type: 'load', files: starter, repository: 'o/r' });
  const r = handle(loaded.state, { id: 2, type: 'simulate', project: 1, scenario, assume, detail: 'steps' });
  if (r.response.type !== 'plan') throw new Error(JSON.stringify(r.response));
  const { plan, derived, text, ms } = r.response;
  return { plan, derived, text, ms, for: { files: 1, project: 1, assume, scenario } };
}

/** A store showing the plan for `source` with no assume entries, as the session leaves it. */
function showing() {
  const store = createSessionStore();
  store.getState().setScenario(source);
  const s = store.getState();
  const plan = planState(s.scenario, s.assume);
  s.planReceived(plan);
  return { store, plan };
}

describe('the store for the panels', () => {
  it('writes a pinned scenario, marks its keys assumed until edited, and asks for the field', () => {
    const store = createSessionStore();
    store.getState().setScenario({ event: 'push', branch: 'main' }, { assumed: ['branch'], from: 'default' });
    store.getState().pinScenario({ event: 'push', branch: 'main', vars: { DEPLOY: '' } }, ['vars'], {
      path: 'vars',
      entry: 'DEPLOY',
    });
    const s = store.getState();
    expect(s.scenario.vars).toEqual({ DEPLOY: '' });
    expect(s.scenarioFrom).toBe('author');
    expect(s.assumed).toEqual(['branch', 'vars']);
    expect(s.fieldFocus).toMatchObject({ path: 'vars', entry: 'DEPLOY' });
    s.patchScenario({ vars: { DEPLOY: 'true' } });
    expect(store.getState().assumed).toEqual(['branch']);
  });

  it('keeps the mark of a pinned dispatch input until that input is edited, whatever happens to the others', () => {
    const store = createSessionStore();
    store.getState().setScenario({ event: 'workflow_dispatch', inputs: { level: 'high' } });
    store
      .getState()
      .pinScenario({ event: 'workflow_dispatch', inputs: { level: 'high', target: '' } }, ['inputs.target'], {
        path: 'inputs.target',
      });
    store.getState().patchScenario({ inputs: { level: 'low', target: '' } });
    expect(store.getState().assumed).toEqual(['inputs.target']);
    store.getState().patchScenario({ inputs: { level: 'low', target: 'prod' } });
    expect(store.getState().assumed).toEqual([]);
  });

  it('forgets a focus request once the form took it, and only that one', () => {
    const store = createSessionStore();
    store.getState().focusField({ path: 'changed' });
    const first = store.getState().fieldFocus!.seq;
    store.getState().focusField({ path: 'action' });
    store.getState().fieldFocused(first);
    expect(store.getState().fieldFocus?.path).toBe('action');
    store.getState().fieldFocused(store.getState().fieldFocus!.seq);
    expect(store.getState().fieldFocus).toBeUndefined();
  });

  it('opens the YAML pane on the file of a line it shows, until the next selection', () => {
    const store = createSessionStore();
    expect(store.getState().ui.prefs.collapsed.yaml).toBe(true);
    store.getState().revealLine({ file: 'a.yml', line: 4 });
    let s = store.getState();
    expect(s.ui.prefs.collapsed.yaml).toBe(false);
    expect(s.ui.yamlFile).toBe('a.yml');
    expect(s.reveal).toMatchObject({ file: 'a.yml', line: 4 });
    s.select('b.yml', 'build');
    s = store.getState();
    expect(s.ui.yamlFile).toBeUndefined();
    expect('yamlFile' in s.ui).toBe(false);
  });

  it('keeps the tab the author picked when the selection already held is selected again', () => {
    const store = createSessionStore();
    store.getState().select('ci.yml', undefined);
    store.getState().setYamlFile('release.yml');
    const before = store.getState();
    before.select('ci.yml', undefined);
    expect(store.getState()).toBe(before);
    expect(store.getState().ui.yamlFile).toBe('release.yml');
    store.getState().select('ci.yml', 'build');
    expect(store.getState().ui.yamlFile).toBeUndefined();
  });

  it('toggles a pane and switches the panel tab as preferences', () => {
    const store = createSessionStore();
    store.getState().togglePane('right');
    expect(store.getState().ui.prefs.collapsed).toEqual({ left: false, right: true, yaml: true });
    store.getState().togglePane('right');
    expect(store.getState().ui.prefs.collapsed.right).toBe(false);
    store.getState().setPanel('problems');
    expect(store.getState().ui.prefs.panel).toBe('problems');
  });

  it('records a pin over the plan shown, with the very inputs it leaves', () => {
    const { store, plan } = showing();
    store.getState().pinAssume([detect]);
    const pinned = store.getState();
    const pin = pinned.pin!;
    expect([pinned.assume, pinned.stale]).toEqual([[detect], true]);
    expect(pin.before!.plan).toBe(plan.plan);
    expect(pin.before!.derived).toBe(plan.derived);
    expect(pin.assume).toBe(pinned.assume);
    expect(pin.scenario).toBe(pinned.scenario);
    expect(pin.after).toBeUndefined();

    pinned.pinScenario({ ...source, changed: ['docs/**'] }, ['changed'], { path: 'changed' });
    const s = store.getState();
    const again = s.pin!;
    expect(again.seq).toBeGreaterThan(pin.seq);
    expect(again.scenario).toBe(s.scenario);
    expect(again.assume).toBe(s.assume);
    expect(again.before!.plan).toBe(plan.plan);
  });

  it('keeps the plain assume edits of the Assumptions list from being pins', () => {
    const { store } = showing();
    store.getState().setAssume([detect]);
    expect(store.getState().pin).toBeUndefined();
  });

  it('settles a pin with the plan simulated from its very inputs, and only once', () => {
    const { store, plan: before } = showing();
    store.getState().pinAssume([detect]);
    const pin = store.getState().pin!;

    // An older reply, and a plan for equal inputs that are not the pin's objects, leave it waiting.
    store.getState().planReceived(before);
    expect(store.getState().pin?.after).toBeUndefined();
    store.getState().planReceived(planState({ ...pin.scenario }, [...pin.assume]));
    expect(store.getState().pin?.after).toBeUndefined();

    const answer = planState(pin.scenario, pin.assume);
    store.getState().planReceived(answer);
    const settled = store.getState().pin!;
    expect(settled.seq).toBe(pin.seq);
    expect(settled.after?.plan).toBe(answer.plan);
    expect(settled.after?.changes.map((c) => c.label)).toEqual(['build.#3']);
    expect(settled.after?.sentence).toBe('pinned; build.#3 now runs');

    // A second plan for the same inputs keeps what the first said.
    store.getState().planReceived(planState(pin.scenario, pin.assume));
    expect(store.getState().pin).toBe(settled);
  });

  it('lets go of the plan a pin was made over once the pin is settled', () => {
    const { store } = showing();
    store.getState().pinAssume([detect]);
    const pin = store.getState().pin!;
    expect(pin.before).toBeDefined();
    const answer = planState(pin.scenario, pin.assume);
    store.getState().planReceived(answer);
    const settled = store.getState().pin!;
    expect(Object.keys(settled).sort()).toEqual(['after', 'assume', 'scenario', 'seq']);
    expect(settled).toMatchObject({ seq: pin.seq, scenario: pin.scenario, assume: pin.assume });
    expect(settled.after?.plan).toBe(answer.plan);
  });

  it('drops a pin with the files it was made over, so the next files never settle it', () => {
    const { store } = showing();
    store.getState().pinAssume([detect]);
    store.getState().hoverUnknown('scenario.changed');
    store.getState().showUnknown('scenario.changed');
    const pin = store.getState().pin!;
    expect(pin.after).toBeUndefined();

    store.getState().setFiles({ ...starter }, { kind: 'sample', name: 'starter' });
    let s = store.getState();
    expect([s.pin, s.hoveredUnknown, s.unknownFocus]).toEqual([undefined, undefined, undefined]);
    // The new files' first plan, simulated from the very inputs the pin left, finds no pin to settle.
    s.planReceived(planState(pin.scenario, pin.assume));
    expect(store.getState().pin).toBeUndefined();

    s = store.getState();
    s.pinAssume([]);
    s.hoverUnknown('scenario.changed');
    s.showUnknown('scenario.changed');
    s.forgetSource();
    s = store.getState();
    expect([s.pin, s.hoveredUnknown, s.unknownFocus]).toEqual([undefined, undefined, undefined]);
  });

  it('keeps counting pins across files that dropped one, so the next flashes the other way', () => {
    const { store } = showing();
    store.getState().pinAssume([detect]);
    const first = store.getState().pin!.seq;
    store.getState().setFiles({ ...starter }, { kind: 'sample', name: 'starter' });
    const s = store.getState();
    s.planReceived(planState(s.scenario, s.assume));
    store.getState().pinAssume([]);
    const next = store.getState().pin!.seq;
    expect(next).toBe(first + 1);
    expect(next % 2).not.toBe(first % 2);
  });

  it('never settles a pin made before the first plan, which it changed nothing of', () => {
    const store = createSessionStore();
    store.getState().pinAssume([detect]);
    const s = store.getState();
    expect(s.pin?.before).toBeUndefined();
    s.planReceived(planState(s.scenario, s.assume));
    expect(store.getState().pin?.after).toBeUndefined();
  });

  it('holds the hovered unknown, and leaves the state alone when it is the one held', () => {
    const store = createSessionStore();
    const id = '.github/workflows/ci.yml#build/steps.detect.outputs.changed';
    store.getState().hoverUnknown(id);
    const held = store.getState();
    expect(held.hoveredUnknown).toBe(id);
    held.hoverUnknown(id);
    expect(store.getState()).toBe(held);
    held.hoverUnknown(undefined);
    expect(store.getState().hoveredUnknown).toBeUndefined();
  });

  it('opens the right pane on the Unknowns tab to show an unknown, and forgets the request once taken, only that one', () => {
    const store = createSessionStore();
    store.getState().togglePane('right');
    store.getState().setPanel('reasons');
    store.getState().showUnknown('scenario.changed');
    let s = store.getState();
    expect(s.ui.prefs.panel).toBe('unknowns');
    expect(s.ui.prefs.collapsed.right).toBe(false);
    expect(s.unknownFocus?.id).toBe('scenario.changed');

    const first = s.unknownFocus!.seq;
    s.showUnknown('github.event.pull_request.labels.*.name');
    s.unknownFocused(first);
    s = store.getState();
    expect(s.unknownFocus?.id).toBe('github.event.pull_request.labels.*.name');
    s.unknownFocused(s.unknownFocus!.seq);
    expect(store.getState().unknownFocus).toBeUndefined();
  });
});
