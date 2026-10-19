// @vitest-environment happy-dom
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { ErrorBanner } from '../src/app/ErrorBanner';
import { AppProvider } from '../src/app/providers';
import { ScenarioForm } from '../src/app/ScenarioForm';
import { createSessionStore, initialSessionState, type Issue } from '../src/state/store';
import type { Outline } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';

const outline: Outline = {
  files: [],
  workflows: [
    {
      path: CI,
      name: 'CI',
      callable: false,
      events: [
        {
          event: 'push',
          branches: ['main', 'release/**'],
          branchesIgnore: [],
          tags: ['v*'],
          paths: ['src/**'],
        },
        {
          event: 'pull_request',
          branches: ['main'],
          types: { allowed: ['opened', 'closed'], all: ['opened', 'closed', 'labeled'], narrowed: true },
        },
        { event: 'workflow_dispatch' },
      ],
      dispatch: [
        { name: 'dry', type: 'boolean', required: false, default: false },
        { name: 'target', type: 'environment', required: true },
      ],
      jobs: [],
      onLine: 1,
    },
    {
      path: '.github/workflows/after.yml',
      name: 'After',
      callable: false,
      events: [
        { event: 'workflow_run', workflows: ['CI'], branches: ['main'] },
        { event: 'workflow_dispatch' },
      ],
      dispatch: [
        { name: 'level', type: 'choice', required: false, default: 'low', options: ['low', 'high'] },
      ],
      jobs: [],
      onLine: 1,
    },
  ],
  events: { pull_request: { types: ['opened', 'closed', 'labeled'], default: ['opened'] } },
};

/** The form over a store that holds a loaded project, the focused workflow and the scenario given. */
function mount(scenario: ScenarioInput, assumed: string[] = [], project: Outline = outline) {
  const store = createSessionStore({
    ...initialSessionState(),
    project: { status: 'ready', version: 1, outline: project, files: 2 },
    scenario,
    scenarioFrom: assumed.length ? 'default' : 'url',
    assumed,
    focus: CI,
  });
  render(
    <AppProvider app={{ store } as unknown as App}>
      <ErrorBanner />
      <ScenarioForm />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

const refused = (issues: Issue[]) => ({ kind: 'scenario' as const, message: 'refused', issues });
const describedBy = (el: HTMLElement): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' | ');

describe('the field groups', () => {
  afterEach(cleanup);

  it("fills the branch from the filters' chips, a glob with a sample that matches it", async () => {
    const { store, user } = mount({ event: 'push', branch: 'dev' });
    const branch = screen.getByRole<HTMLInputElement>('textbox', { name: 'Branch' });
    expect(describedBy(branch)).toBe('branches: main, release/**');
    const chips = screen.getByRole('group', { name: 'Branches from the filters' });
    await user.click(within(chips).getByRole('button', { name: 'release/x · release/**' }));
    expect(store.getState().scenario).toEqual({ event: 'push', branch: 'release/x' });
    await user.click(within(chips).getByRole('button', { name: 'main' }));
    expect(branch.value).toBe('main');
    await user.click(screen.getByRole('radio', { name: 'Tag' }));
    await user.click(screen.getByRole('button', { name: 'v1.0.0 · v*' }));
    expect(store.getState().scenario).toEqual({ event: 'push', tag: 'v1.0.0' });
  });

  it('adds a file each paths pattern selects on a line of its own, and says unknown while empty', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    const changed = screen.getByLabelText<HTMLTextAreaElement>(/Changed files/);
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(describedBy(changed)).toBe('paths: src/**');
    await user.type(changed, 'README.md');
    await user.click(screen.getByRole('button', { name: 'src/example.ts · src/**' }));
    expect(changed.value).toBe('README.md\nsrc/example.ts');
    expect(store.getState().scenario.changed).toEqual(['README.md', 'src/example.ts']);
    expect(screen.queryByText('unknown')).toBeNull();
  });

  it('adds and takes out the [skip ci] marker of the commit message', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    const message = screen.getByLabelText<HTMLTextAreaElement>('Commit message');
    await user.type(message, 'fix: x');
    const skip = screen.getByRole<HTMLInputElement>('switch', { name: '[skip ci]' });
    expect(skip.checked).toBe(false);
    await user.click(skip);
    expect(store.getState().scenario.message).toBe('fix: x [skip ci]');
    expect(skip.checked).toBe(true);
    expect(message.value).toBe('fix: x [skip ci]');
    await user.click(skip);
    expect(store.getState().scenario.message).toBe('fix: x');
    act(() => store.getState().patchScenario({ message: 'docs [ci skip]' }));
    expect(skip.checked).toBe(true);
  });

  it('keeps Advanced closed until one of its keys is set', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    const toggle = screen.getByRole('button', { name: 'Advanced' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Commit SHA')).toBeNull();
    act(() => store.getState().patchScenario({ sha: 'abc1234' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Commit SHA').value).toBe('abc1234');
    await user.click(toggle);
    expect(screen.queryByLabelText('Commit SHA')).toBeNull();
    await user.click(toggle);
    expect(screen.getByLabelText<HTMLInputElement>('Commit SHA').value).toBe('abc1234');
  });

  it('opens Advanced on a link that sets one of its keys, and keeps the lines as they are typed', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main', vars: { DEPLOY: 'true' } });
    const vars = screen.getByLabelText<HTMLTextAreaElement>('Variables');
    expect(vars.value).toBe('DEPLOY=true');
    await user.type(vars, '{Enter}REGION = eu{Enter}');
    expect(vars.value).toBe('DEPLOY=true\nREGION = eu\n');
    expect(store.getState().scenario.vars).toEqual({ DEPLOY: 'true', REGION: 'eu' });
    const secrets = screen.getByLabelText<HTMLTextAreaElement>('Secrets');
    expect(describedBy(secrets)).toContain('GITHUB_TOKEN always exists');
    await user.type(secrets, 'NPM_TOKEN{Enter}');
    expect(secrets.value).toBe('NPM_TOKEN\n');
    expect(store.getState().scenario.secrets).toEqual(['NPM_TOKEN']);
    await user.type(screen.getByLabelText('Actor'), 'octocat');
    await user.click(screen.getByRole('switch', { name: 'The actor is a bot' }));
    expect(store.getState().scenario.actor).toEqual({ login: 'octocat', bot: true });
    await user.selectOptions(screen.getByLabelText('Platform'), 'ghes');
    expect(store.getState().scenario.platform).toBe('ghes');
    await user.selectOptions(screen.getByLabelText('Platform'), 'dotcom');
    expect(store.getState().scenario.platform).toBeUndefined();
  });

  it('shows a refusal on its field and sums up what no field shows', async () => {
    const { store } = mount({ event: 'push', branch: 'main', sha: 'XYZ' });
    act(() =>
      store.getState().rejected(
        refused([
          { path: ['sha'], message: 'a commit SHA is 7 to 40 lowercase hex digits' },
          { path: [], message: 'give one of ref, branch or tag' },
        ]),
      ),
    );
    const sha = screen.getByLabelText('Commit SHA');
    expect(sha.getAttribute('aria-invalid')).toBe('true');
    const error = document.getElementById(sha.getAttribute('aria-errormessage')!);
    expect(error?.textContent).toBe('a commit SHA is 7 to 40 lowercase hex digits');
    const summary = screen.getByText('The scenario was refused').parentElement!;
    expect(within(summary).getByText('give one of ref, branch or tag')).toBeTruthy();
    expect(within(summary).queryByText(/a commit SHA is/)).toBeNull();
    const branch = screen.getByRole('textbox', { name: 'Branch' });
    expect(branch.getAttribute('aria-invalid')).toBeNull();
    expect(branch.getAttribute('aria-errormessage')).toBeNull();
    act(() => store.getState().patchScenario({ sha: 'abc1234' }));
    expect(sha.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText(/give one of ref, branch or tag/)).toBeNull();
  });

  it('announces a refusal once, in the page banner, and keeps the copies in the form quiet', () => {
    const { store } = mount({ event: 'push', branch: 'main', sha: 'XYZ' });
    act(() =>
      store.getState().rejected(
        refused([
          { path: ['sha'], message: 'a commit SHA is 7 to 40 lowercase hex digits' },
          { path: [], message: 'give one of ref, branch or tag' },
        ]),
      ),
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toContain('sha: a commit SHA is 7 to 40 lowercase hex digits');
    expect(alerts[0]!.textContent).toContain('give one of ref, branch or tag');
    expect(within(screen.getByRole('form', { name: 'Scenario' })).queryAllByRole('alert')).toEqual([]);
  });

  it('opens Advanced again for a refusal of a key it holds, after the author closed it', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main', sha: 'XYZ' });
    const toggle = screen.getByRole('button', { name: 'Advanced' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const refusal = refused([{ path: ['sha'], message: 'a commit SHA is 7 to 40 lowercase hex digits' }]);
    act(() => store.getState().rejected(refusal));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Advanced · refused');
    const sha = screen.getByLabelText('Commit SHA');
    expect(document.getElementById(sha.getAttribute('aria-errormessage')!)?.textContent).toBe(
      'a commit SHA is 7 to 40 lowercase hex digits',
    );
    await user.click(toggle);
    act(() => store.getState().clearError());
    act(() => store.getState().rejected(refusal));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Advanced · refused');
  });

  it('opens Advanced to show a refusal of one of its keys', () => {
    const { store } = mount({ event: 'push', branch: 'main' });
    act(() =>
      store
        .getState()
        .rejected(refused([{ path: ['repository'], message: 'a repository is written owner/name' }])),
    );
    const repository = screen.getByLabelText('Repository');
    expect(repository.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText('The scenario was refused')).toBeNull();
  });

  it('writes the fork into the actor and keeps the rest of it, and offers Merged for a closed pull request', async () => {
    const { store, user } = mount({ event: 'pull_request', action: 'opened', actor: { login: 'octo' } });
    const base = screen.getByLabelText<HTMLInputElement>('Base branch');
    expect(describedBy(base)).toBe('branches (the base): main');
    await user.click(screen.getByRole('button', { name: 'main' }));
    expect(store.getState().scenario.base).toBe('main');
    const fork = screen.getByRole('switch', { name: 'From a fork' });
    await user.click(fork);
    expect(store.getState().scenario.actor).toEqual({ login: 'octo', fork: true });
    await user.click(fork);
    expect(store.getState().scenario.actor).toEqual({ login: 'octo' });
    expect(screen.queryByLabelText('Merged')).toBeNull();
    await user.selectOptions(screen.getByLabelText(/Activity type/), 'closed');
    await user.selectOptions(screen.getByLabelText('Merged'), 'true');
    expect(store.getState().scenario).toMatchObject({ action: 'closed', merged: true });
  });

  it('tells a pull request closed without merging from one whose merge is unknown', async () => {
    const { store, user } = mount({ event: 'pull_request', action: 'closed', merged: false });
    const merged = screen.getByLabelText<HTMLSelectElement>('Merged');
    expect(merged.value).toBe('false');
    await user.selectOptions(merged, 'true');
    expect(store.getState().scenario.merged).toBe(true);
    await user.selectOptions(merged, 'false');
    expect(store.getState().scenario.merged).toBe(false);
    await user.selectOptions(merged, '');
    expect(store.getState().scenario).toEqual({ event: 'pull_request', action: 'closed' });
    expect(merged.value).toBe('');
  });

  it('keeps Merged in place on an opened pull request while the author makes it unknown', async () => {
    const { store, user } = mount({ event: 'pull_request', action: 'opened', merged: true });
    const merged = screen.getByLabelText<HTMLSelectElement>('Merged');
    await user.selectOptions(merged, '');
    expect(store.getState().scenario.merged).toBeUndefined();
    expect(screen.getByLabelText('Merged')).toBe(merged);
    expect(document.activeElement).toBe(merged);
    act(() => store.getState().setScenario({ event: 'pull_request', action: 'opened' }, { from: 'url' }));
    expect(screen.queryByLabelText('Merged')).toBeNull();
  });

  it('leaves the fork behind when the event is no pull request, and shows a fork a link sets', async () => {
    const { store, user } = mount({ event: 'pull_request', base: 'main' });
    await user.click(screen.getByRole('switch', { name: 'From a fork' }));
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'push');
    expect(store.getState().scenario).toEqual({ event: 'push', base: 'main' });
    expect(screen.queryByRole('switch', { name: 'From a fork' })).toBeNull();
    act(() =>
      store.getState().setScenario({ event: 'push', branch: 'main', actor: { fork: true } }, { from: 'url' }),
    );
    const fork = screen.getByRole<HTMLInputElement>('switch', { name: 'From a fork' });
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
    await user.click(fork);
    expect(store.getState().scenario).toEqual({ event: 'push', branch: 'main' });
    expect(screen.getByRole('switch', { name: 'From a fork' })).toBe(fork);
    expect(document.activeElement).toBe(fork);
  });

  it('shows no ref beside a pull request, which runs on a ref of its own', () => {
    mount({ event: 'pull_request', action: 'closed', branch: 'feat' });
    expect(screen.queryByRole('textbox', { name: 'Branch' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Branch' })).toBeNull();
  });

  it("keeps a merge group's ref field under the caret while it is emptied", async () => {
    const { store, user } = mount({ event: 'merge_group', branch: 'ab' });
    const branch = screen.getByRole<HTMLInputElement>('textbox', { name: 'Branch' });
    await user.click(branch);
    await user.keyboard('{End}{Backspace}{Backspace}');
    expect(store.getState().scenario).toEqual({ event: 'merge_group' });
    expect(screen.getByRole('textbox', { name: 'Branch' })).toBe(branch);
    expect(document.activeElement).toBe(branch);
    await user.keyboard('c');
    expect(store.getState().scenario).toEqual({ event: 'merge_group', branch: 'c' });
  });

  it('shows a ref that is neither a branch nor a tag under Advanced, and writes it there as it is', async () => {
    const { store, user } = mount({ event: 'push', ref: 'refs/pull/7/merge' });
    const branch = screen.getByRole<HTMLInputElement>('textbox', { name: 'Branch' });
    expect(branch.value).toBe('');
    const ref = screen.getByRole<HTMLInputElement>('textbox', { name: 'Ref' });
    expect(ref.value).toBe('refs/pull/7/merge');
    await user.clear(ref);
    await user.type(ref, 'refs/pull/8/merge');
    expect(store.getState().scenario).toEqual({ event: 'push', ref: 'refs/pull/8/merge' });
    await user.type(branch, 'dev');
    expect(store.getState().scenario).toEqual({ event: 'push', branch: 'dev' });
    expect(ref.value).toBe('');
  });

  it('marks what the page chose, with a note that focus or a resting pointer draws and Escape puts away', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' }, ['event', 'branch']);
    const event = screen.getAllByRole<HTMLSelectElement>('combobox')[0]!;
    const branch = screen.getByRole<HTMLInputElement>('textbox', { name: 'Branch' });
    expect(event.className).toContain('assumed');
    expect(branch.className).toContain('assumed');
    expect(describedBy(branch)).toContain('chosen for you; change it');
    const note = (el: HTMLElement) =>
      document.getElementById(el.getAttribute('aria-describedby')!.split(' ').at(-1)!)!;
    expect(note(event).getAttribute('role')).toBe('tooltip');
    expect(note(event).dataset.open).toBeUndefined();
    await user.tab();
    expect(document.activeElement).toBe(event);
    expect(note(event).dataset.open).toBe('true');
    expect(note(event).textContent).toBe('chosen for you; change it');
    await user.keyboard('{Escape}');
    expect(note(event).dataset.open).toBeUndefined();
    expect(document.activeElement).toBe(event);
    await user.hover(branch);
    await waitFor(() => expect(note(branch).dataset.open).toBe('true'));
    await user.unhover(branch);
    expect(note(branch).dataset.open).toBeUndefined();
    await user.type(branch, 'x');
    expect(store.getState().assumed).toEqual(['event']);
    expect(branch.className).not.toContain('assumed');
    expect(document.activeElement).toBe(branch);
    expect(describedBy(branch)).not.toContain('chosen for you');
  });

  it('groups the dispatch inputs by workflow, marks the required ones and sends no default', async () => {
    const { store, user } = mount({ event: 'workflow_dispatch', environments: ['staging', 'production'] });
    const ci = screen.getByRole('region', { name: 'CI' });
    const after = screen.getByRole('region', { name: 'After' });
    expect(within(ci).getByText('required')).toBeTruthy();
    const target = within(ci).getByLabelText<HTMLInputElement>('target');
    expect(target.getAttribute('aria-required')).toBe('true');
    const list = document.getElementById(target.getAttribute('list')!);
    expect(Array.from(list!.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'staging',
      'production',
    ]);
    const level = within(after).getByLabelText<HTMLSelectElement>('level');
    expect(level.selectedOptions[0]?.textContent).toBe('default: low');
    await user.type(target, 'production');
    await user.selectOptions(level, 'high');
    expect(store.getState().scenario.inputs).toEqual({ target: 'production', level: 'high' });
    await user.selectOptions(level, '');
    expect(store.getState().scenario.inputs).toEqual({ target: 'production' });
    expect(screen.getByRole('radio', { name: 'Branch' })).toBeTruthy();
  });

  it('names a refused input no workflow declares in the description of the inputs', () => {
    const { store } = mount({ event: 'workflow_dispatch', inputs: { typo: 'x' } });
    act(() => store.getState().rejected(refused([{ path: ['inputs', 'typo'], message: 'Invalid input' }])));
    const inputs = screen.getByRole('group', { name: 'Inputs' });
    expect(describedBy(inputs)).toBe('typo: Invalid input');
  });

  it('shows a choice input of another type as the text the engine reads, not as its default', () => {
    mount({ event: 'workflow_dispatch', inputs: { level: true } });
    const level = screen.getByLabelText<HTMLSelectElement>('level');
    expect(level.value).toBe('true');
    expect(level.selectedOptions[0]?.textContent).toBe('true · not an option');
  });

  it('shows a refusal of one dispatch input on that input', () => {
    const { store } = mount({ event: 'workflow_dispatch', inputs: { dry: 'yes' } });
    act(() =>
      store.getState().rejected(refused([{ path: ['inputs', 'dry'], message: 'expected a boolean' }])),
    );
    const dry = screen.getByRole('switch', { name: /dry/ });
    expect(dry.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(dry.getAttribute('aria-errormessage')!)?.textContent).toBe(
      'expected a boolean',
    );
  });

  it("keeps the triggering run's branch typed before the workflow, and chips it from the filters", async () => {
    const { store, user } = mount({ event: 'workflow_run' });
    const branch = screen.getByLabelText<HTMLInputElement>('Its branch');
    expect(describedBy(branch)).toBe('branches: main');
    await user.type(branch, 'dev');
    expect(branch.value).toBe('dev');
    expect(store.getState().scenario.workflow_run).toBeUndefined();
    await user.selectOptions(screen.getByLabelText(/Triggering workflow/), 'CI');
    expect(store.getState().scenario.workflow_run).toEqual({ name: 'CI', branch: 'dev' });
    await user.click(screen.getByRole('button', { name: 'main' }));
    expect(store.getState().scenario.workflow_run).toEqual({ name: 'CI', branch: 'main' });
    await user.clear(branch);
    expect(store.getState().scenario.workflow_run).toEqual({ name: 'CI' });
  });

  it('shows a value no option holds as itself', () => {
    mount({ event: 'schedule', cron: '0 0 * * *' });
    const cron = screen.getByLabelText<HTMLSelectElement>('Cron');
    expect(cron.value).toBe('0 0 * * *');
    expect(cron.selectedOptions[0]?.textContent).toBe('0 0 * * * · no workflow schedules it');
  });
});

describe('the activity type', () => {
  afterEach(cleanup);

  const listening = (...events: Outline['workflows'][number]['events']): Outline => ({
    files: [],
    workflows: [{ path: CI, name: 'CI', callable: false, events, jobs: [], onLine: 1 }],
    events: outline.events,
  });

  it('offers the default types first when no workflow narrows, and marks the rest', () => {
    mount({ event: 'pull_request' }, [], listening({ event: 'pull_request' }));
    const select = screen.getByLabelText<HTMLSelectElement>(/Activity type/);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      '(any default type)',
      'opened',
      'closed · not a default type',
      'labeled · not a default type',
    ]);
  });

  it('offers the custom types a dispatch listens to, and shows one a pin adds', () => {
    const custom = listening({
      event: 'repository_dispatch',
      types: { allowed: ['deploy'], all: [], narrowed: true },
    });
    mount({ event: 'repository_dispatch', action: 'build' }, [], custom);
    const select = screen.getByLabelText<HTMLSelectElement>(/Activity type/);
    expect(select.value).toBe('build');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['build · not in types:', 'deploy']);
  });
});
