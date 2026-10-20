// @vitest-environment happy-dom
import type { AssumeEntry, NodeId, ScenarioInput } from '@simulci/engine';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { sampleByName } from '../src/input/samples';
import { NodeDetails } from '../src/panels/NodeDetails';
import { type Fact, type FactSection, nodeFacts, nodeHeading } from '../src/panels/node-facts';
import { planIndex } from '../src/plan/index';
import { createSessionStore, initialSessionState, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

/** The worker's plan for a repository and a scenario, as the store holds it. */
function planned(
  files: Record<string, string>,
  scenario: ScenarioInput,
  assume: AssumeEntry[] = [],
): PlanState {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
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
  return { plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1 } };
}

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const SETUP = `${RELEASE}#publish/~github-actions-setup`;
const CACHE = `${SETUP}>.github/actions/setup/steps.cache`;
const starter = sampleByName('starter')!.files;
const monorepo = sampleByName('monorepo')!.files;

// A push to main lays out CI with its matrix; the entry makes the detect step's output known.
const push = planned(starter, { event: 'push', branch: 'main' }, [
  { step: 'build.detect', outputs: { changed: 'true' } },
]);
// A tag push runs Release, whose publish job uses the composite setup action.
const tag = planned(starter, { event: 'push', tag: 'v1.0.0' });
// web calls package.yml, a reusable workflow.
const mono = planned(monorepo, { event: 'push', branch: 'main' });

const factsOf = (state: PlanState, id: NodeId): FactSection[] => nodeFacts(state, planIndex(state), id);
const titles = (sections: FactSection[]): string[] => sections.map((s) => s.title);

/** A section's facts as `label → words`: text and values as written, nodes by label, checks by verdict and result. */
function said(sections: FactSection[], title: string): Record<string, string> {
  const section = sections.find((s) => s.title === title);
  if (!section) throw new Error(`no section ${title} in ${titles(sections).join(', ')}`);
  return Object.fromEntries(section.facts.map((f) => [f.label, words(f)]));
}

function words(f: Fact): string {
  const v = f.value;
  if (v.kind === 'nodes') return v.nodes.map((n) => n.label).join(' ');
  if (v.kind === 'check') return `${v.verdict} ${v.result.text}`;
  return v.text;
}

const fact = (sections: FactSection[], title: string, label: string): Fact | undefined =>
  sections.find((s) => s.title === title)?.facts.find((f) => f.label === label);

describe('nodeFacts', () => {
  it('says a job’s matrix, its result as needs reads it, and the checks its legs report', () => {
    const test = factsOf(push, `${CI}#test`);
    expect(titles(test)).toEqual(['Job', 'Matrix', 'Checks']);
    expect(said(test, 'Job')).toEqual({
      'job id': 'test',
      // The job runs where its workflow does, so needs reads its legs' result whether or not CI is triggered.
      result: 'success',
      'continue-on-error': 'false',
      check: 'test (…)',
      'check when skipped': 'test',
    });
    expect(fact(test, 'Job', 'result')?.note).toBe('as needs.test.result reads it');
    expect(said(test, 'Matrix')).toEqual({
      keys: 'node',
      count: '2',
      'legs planned': '2',
      exact: 'yes',
      dynamic: 'no',
      'fail-fast': 'false',
    });
    expect(said(test, 'Checks')).toEqual({ 'test (22)': 'maybe success', 'test (24)': 'maybe success' });
  });

  it('lists a job’s needs as nodes to select, and the runner and environment of its one bare leg', () => {
    const deploy = factsOf(push, `${CI}#deploy`);
    const needs = fact(deploy, 'Job', 'needs')?.value;
    expect(needs).toEqual({
      kind: 'nodes',
      nodes: [
        { id: `${CI}#test`, label: 'test' },
        { id: `${CI}#build`, label: 'build' },
      ],
    });
    expect(said(deploy, 'Job')).toMatchObject({ 'runs-on': 'ubuntu-latest', environment: 'production' });
    expect(titles(deploy)).toEqual(['Job', 'Checks']);
  });

  it('says a leg’s key, values, runner and its own check', () => {
    const leg = factsOf(push, `${CI}#test[node=22]`);
    expect(said(leg, 'Leg')).toEqual({ leg: 'node=22', result: 'success', 'runs-on': 'ubuntu-latest' });
    expect(said(leg, 'Matrix values')).toEqual({ node: '22' });
    expect(said(leg, 'Checks')).toEqual({ 'test (22)': 'maybe success' });
  });

  it('says a step’s key, id, uses or run, outcome and with, and an output a mock made known with the mock', () => {
    const setupNode = factsOf(push, `${CI}#test[node=22]/~actions-setup-node`);
    expect(said(setupNode, 'Step')).toEqual({
      key: '~actions-setup-node',
      uses: 'actions/setup-node@v4',
      outcome: 'success',
      'continue-on-error': 'false',
    });
    expect(said(setupNode, 'With')).toEqual({ 'node-version': '22' });
    const detect = factsOf(push, `${CI}#build/steps.detect`);
    expect(said(detect, 'Step')).toMatchObject({ key: 'steps.detect', 'step id': 'detect', run: 'a script' });
    expect(fact(detect, 'Outputs', 'changed')?.value).toEqual({
      kind: 'value',
      text: 'true',
      known: true,
      by: 'assume[0]',
    });
    expect(titles(detect)).not.toContain('Checks');
  });

  it('names an unknown output’s candidates and the unknown it waits on by unit path', () => {
    const cache = factsOf(tag, CACHE);
    expect(said(cache, 'Outputs')['cache-hit']).toBe(
      "? one of true, false, '' (publish.#2/cache.outputs.cache-hit)",
    );
    expect(fact(cache, 'Outputs', 'cache-hit')?.value).toMatchObject({ known: false });
    expect(said(cache, 'With')).toMatchObject({ path: 'node_modules' });
  });

  it('shows the composite action under the step that uses it, and on its own', () => {
    expect(said(factsOf(tag, SETUP), 'Action')).toEqual({ path: '.github/actions/setup' });
    expect(titles(factsOf(tag, `${SETUP}>.github/actions/setup`))).toEqual(['Action']);
  });

  it('says a workflow’s path, name, events and conclusion, and every check its jobs report', () => {
    const ci = factsOf(push, CI);
    expect(said(ci, 'Workflow')).toEqual({
      path: CI,
      name: 'CI',
      'listens to': 'push, pull_request, workflow_dispatch',
      conclusion: 'success',
    });
    expect(Object.keys(said(ci, 'Checks'))).toEqual(['test (22)', 'test (24)', 'build', 'deploy', 'preview']);
    expect(said(ci, 'Checks').preview).toBe('no skipped');
  });

  it('says who calls a called workflow and with what, and gives the calling job the callee’s checks', () => {
    const callee = factsOf(mono, `${CI}#web>.github/workflows/package.yml`);
    expect(said(callee, 'Workflow')).toMatchObject({ 'listens to': 'workflow_call', 'called by': 'web' });
    expect(said(callee, 'Inputs')).toEqual({ name: 'web' });
    const web = factsOf(mono, `${CI}#web`);
    expect(said(web, 'Job')).toMatchObject({ uses: './.github/workflows/package.yml', needs: 'changes' });
    expect(said(web, 'With')).toEqual({ name: 'web' });
    expect(said(web, 'Checks')).toEqual({ 'web / test': 'maybe success', 'web / lint': 'maybe success' });
  });

  it('has nothing to say of an id the plan does not have', () => {
    expect(factsOf(push, `${CI}#gone`)).toEqual([]);
    expect(nodeHeading(push, planIndex(push), `${CI}#gone`)).toBeUndefined();
  });
});

describe('nodeHeading', () => {
  const heading = (state: PlanState, id: NodeId) => nodeHeading(state, planIndex(state), id);

  it('names a node as the canvas does, with its kind, verdict and unit path', () => {
    expect(heading(push, `${CI}#test[node=22]`)).toEqual({
      kind: 'leg',
      verdict: 'maybe',
      name: 'node=22',
      path: 'test[node=22]',
    });
    expect(heading(tag, CACHE)).toMatchObject({
      kind: 'step',
      name: 'actions/cache@v4',
      path: 'publish.#2/cache',
    });
    expect(heading(tag, `${SETUP}>.github/actions/setup`)).toMatchObject({
      kind: 'composite',
      name: '.github/actions/setup',
    });
    expect(heading(push, CI)).toMatchObject({ kind: 'workflow', name: 'CI', path: CI });
    expect(heading(mono, `${CI}#web>.github/workflows/package.yml`)).toMatchObject({
      name: 'Package',
      path: '.github/workflows/package.yml',
    });
  });
});

describe('the Node tab', () => {
  afterEach(cleanup);

  function mount(state: PlanState | undefined, sel?: string) {
    const initial = initialSessionState();
    const store = createSessionStore({
      ...initial,
      ...(state ? { plan: state, focus: CI } : {}),
      ...(sel === undefined ? {} : { sel }),
    });
    const panel = createElement('div', { role: 'tabpanel', tabIndex: -1 }, createElement(NodeDetails));
    render(createElement(AppProvider, { app: { store } as unknown as App, children: panel }));
    return { store, user: userEvent.setup() };
  }

  it('shows the selected node’s sections as description lists, a mock’s chip beside the value it made', () => {
    mount(push, 'build.detect');
    expect(screen.getByRole('heading', { name: 'detect' })).toBeTruthy();
    const outputs = screen.getByRole('heading', { name: 'Outputs' }).closest('section')!;
    expect(within(outputs).getByText('changed').tagName).toBe('DT');
    expect(within(outputs).getByText('by assume[0]')).toBeTruthy();
  });

  it('selects a needed job, and keeps the focus in the panel when the button goes with the old facts', async () => {
    const { store, user } = mount(push, 'deploy');
    await user.click(screen.getByRole('button', { name: 'Select build' }));
    expect([store.getState().focus, store.getState().sel]).toEqual([CI, 'build']);
    expect(screen.getByRole('heading', { name: 'build' })).toBeTruthy();
    expect(document.activeElement?.getAttribute('role')).toBe('tabpanel');
  });

  it('shows the focused workflow when nothing inside it is selected', () => {
    mount(push);
    expect(screen.getByRole('heading', { name: 'CI' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select test (22)' })).toBeTruthy();
  });

  it('says when there is no plan', () => {
    mount(undefined);
    expect(screen.getByText('No plan yet.')).toBeTruthy();
  });
});
