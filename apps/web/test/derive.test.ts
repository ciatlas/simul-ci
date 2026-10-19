import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  matchesPatterns,
  matchTrigger,
  parseScenario,
  readSettings,
  type ScenarioInput,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { fieldAria, fieldIds } from '../src/scenario/aria';
import { deriveForm, type HintKey, routeIssues } from '../src/scenario/derive';
import { handle, initialState } from '../src/worker/handle';
import type { Outline } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';
const DOCS = '.github/workflows/docs.yml';

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
          branches: ['main', 'release/**', '!release/old'],
          tags: ['v*'],
          paths: ['src/**'],
          pathsIgnore: ['docs/**'],
        },
        {
          event: 'pull_request',
          branches: ['main', 'feat/*'],
          types: { allowed: ['opened', 'closed'], all: ['opened', 'closed', 'labeled'], narrowed: true },
        },
        { event: 'workflow_dispatch' },
      ],
      dispatch: [
        { name: 'dry', type: 'boolean', required: false, default: false },
        { name: 'env', type: 'environment', required: true },
      ],
      jobs: [],
      onLine: 1,
    },
    {
      path: DOCS,
      callable: false,
      events: [
        { event: 'push', branchesIgnore: ['wip/**'], paths: ['docs/**'] },
        { event: 'schedule', crons: ['0 6 * * 1'] },
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
      dispatch: [{ name: 'target', type: 'choice', required: false, default: 'a', options: ['a', 'b'] }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: { pull_request: { types: ['opened', 'closed', 'labeled'], default: ['opened'] } },
};

const form = (scenario: ScenarioInput, focus: string | undefined = CI) =>
  deriveForm(outline, scenario, focus);

describe('the derived form', () => {
  it("offers the focused workflow's events first, then the others with their listeners, then a dispatch", () => {
    const { events } = form({ event: 'push' });
    expect(events.title).toBe('CI');
    expect(events.focused).toEqual([
      { event: 'push', label: 'push · 2 of 3 workflows' },
      { event: 'pull_request', label: 'pull_request · 1 of 3 workflows' },
      { event: 'workflow_dispatch', label: 'workflow_dispatch · 2 of 3 workflows' },
    ]);
    expect(events.others.map((o) => o.label)).toEqual([
      'schedule · 1 of 3 workflows',
      'workflow_run · 1 of 3 workflows',
    ]);
    expect(form({ event: 'push' }, DOCS).events.focused.map((o) => o.event)).toEqual(['push', 'schedule']);
    expect(deriveForm(outline, { event: 'push' }, undefined).events.focused).toEqual([]);
    const quiet = deriveForm({ ...outline, workflows: [outline.workflows[1]!] }, { event: 'push' }, DOCS);
    expect(quiet.events.title).toBe('docs.yml');
    expect(quiet.events.others).toEqual([
      { event: 'workflow_dispatch', label: 'workflow_dispatch · none listens' },
    ]);
  });

  it('shows the groups each event reads', () => {
    const groups = (scenario: ScenarioInput, o: Outline = outline) => deriveForm(o, scenario, CI).groups;
    expect(groups({ event: 'push', branch: 'main' })).toEqual([
      'event',
      'ref',
      'changedFiles',
      'message',
      'advanced',
    ]);
    expect(groups({ event: 'push', tag: 'v1' })).toEqual(['event', 'ref', 'message', 'advanced']);
    expect(groups({ event: 'pull_request' })).toEqual([
      'event',
      'activityType',
      'pullRequest',
      'changedFiles',
      'message',
      'advanced',
    ]);
    expect(groups({ event: 'pull_request_target' })).toEqual([
      'event',
      'pullRequest',
      'changedFiles',
      'advanced',
    ]);
    expect(groups({ event: 'merge_group' })).toEqual(['event', 'pullRequest', 'advanced']);
    expect(groups({ event: 'release', tag: 'v1' })).toEqual(['event', 'release', 'advanced']);
    expect(groups({ event: 'schedule' })).toEqual(['event', 'cron', 'advanced']);
    expect(groups({ event: 'workflow_run' })).toEqual(['event', 'workflowRun', 'advanced']);
    expect(groups({ event: 'workflow_dispatch' })).toEqual(['event', 'ref', 'dispatch', 'advanced']);
    const none = { ...outline, workflows: [outline.workflows[1]!] };
    expect(groups({ event: 'workflow_dispatch' }, none)).toEqual(['event', 'ref', 'advanced']);
  });

  it('shows a ref an event carries so it can be cleared, but not on a release, which reads its tag', () => {
    const groups = (scenario: ScenarioInput) => form(scenario).groups;
    expect(groups({ event: 'issues' })).toEqual(['event', 'advanced']);
    expect(groups({ event: 'issues', branch: 'dev' })).toEqual(['event', 'ref', 'advanced']);
    expect(groups({ event: 'schedule', ref: 'refs/tags/v1' })).toEqual(['event', 'ref', 'cron', 'advanced']);
    expect(groups({ event: 'release', branch: 'main' })).toEqual(['event', 'release', 'advanced']);
    expect(groups({ event: 'constructor' })).toEqual(['event', 'advanced']);
    expect(form({ event: 'constructor' }).activity).toBeUndefined();
  });

  it('leaves out a ref on the pull-request events, which run on a ref of their own, but not on a merge group', () => {
    const groups = (scenario: ScenarioInput) => form(scenario).groups;
    for (const event of [
      'pull_request',
      'pull_request_target',
      'pull_request_review',
      'pull_request_review_comment',
    ])
      expect(groups({ event, branch: 'feat' })).not.toContain('ref');
    expect(groups({ event: 'merge_group', branch: 'feat' })).toEqual([
      'event',
      'ref',
      'pullRequest',
      'advanced',
    ]);
    expect(groups({ event: 'issues', ref: 'refs/pull/7/merge' })).toEqual(['event', 'advanced']);
  });

  it('keeps the ref field the author is emptying, and the routes to it', () => {
    const kept = deriveForm(outline, { event: 'merge_group' }, CI, { ref: true });
    expect(kept.groups).toEqual(['event', 'ref', 'pullRequest', 'advanced']);
    expect(kept.fields.get('branch')).toBe('ref');
    expect(form({ event: 'merge_group' }).groups).toEqual(['event', 'pullRequest', 'advanced']);
  });

  it('routes the raw ref and a fork to Advanced only where no other group shows them', () => {
    const push = form({ event: 'push' });
    expect(push.fields.get('ref')).toBe('ref');
    expect(push.advanced).not.toContain('rawRef');
    expect(push.fields.get('actor.fork')).toBe('actor.fork');
    expect(push.advanced).toContain('actor.fork');
    const pr = form({ event: 'pull_request' });
    expect(pr.fields.get('ref')).toBe('rawRef');
    expect(pr.advanced).toContain('rawRef');
    expect(pr.fields.get('actor.fork')).toBe('fork');
    expect(pr.advanced).not.toContain('fork');
    expect(pr.advanced).not.toContain('actor.fork');
    expect(form({ event: 'release' }).fields.get('ref')).toBe('tag');
    expect(form({ event: 'issues' }).fields.get('ref')).toBe('rawRef');
  });

  it("hints a push's ref and changed files from every listener's filters, the focused workflow's first", () => {
    const { hints } = form({ event: 'push', branch: 'main' });
    expect(hints.event?.text).toBe('listened to by CI, docs.yml');
    expect(hints.branch).toEqual({
      text: 'branches: main, release/**; not: release/old, wip/**',
      chips: [
        { pattern: 'main', value: 'main' },
        { pattern: 'release/**', value: 'release/x' },
      ],
    });
    expect(hints.tag).toEqual({ text: 'tags: v*', chips: [{ pattern: 'v*', value: 'v1.0.0' }] });
    expect(hints.changed).toEqual({
      text: 'paths: src/**, docs/**; paths-ignore: docs/**',
      chips: [
        { pattern: 'src/**', value: 'src/example.ts' },
        { pattern: 'docs/**', value: 'docs/example.ts' },
      ],
    });
    expect(form({ event: 'push' }, DOCS).hints.changed?.text).toBe(
      'paths: docs/**, src/**; paths-ignore: docs/**',
    );
    expect(hints.base).toBeUndefined();
  });

  it("hints a pull request's base, its types, and the other events' own fields", () => {
    const pr = form({ event: 'pull_request' }).hints;
    expect(pr.action?.text).toBe('types: opened, closed');
    expect(pr.base).toEqual({
      text: 'branches (the base): main, feat/*',
      chips: [
        { pattern: 'main', value: 'main' },
        { pattern: 'feat/*', value: 'feat/x' },
      ],
    });
    expect(pr.changed?.text).toBe('no workflow filters paths on this event');
    const run = form({ event: 'workflow_run' }).hints;
    expect(run.workflow_run).toEqual({ text: 'workflows: CI', chips: [] });
    expect(run['workflow_run.branch']).toEqual({
      text: 'branches: main',
      chips: [{ pattern: 'main', value: 'main' }],
    });
    expect(form({ event: 'schedule' }).hints.cron?.text).toBe(
      'a schedule starts the workflows that list this exact cron',
    );
    expect(form({ event: 'release' }).hints.release?.text).toBe(
      'required: without a tag, github.ref is unknown',
    );
    expect(form({ event: 'issues' }).hints.event?.text).toBe('no workflow listens to issues');
    const open = deriveForm(
      { ...outline, workflows: [outline.workflows[1]!] },
      { event: 'pull_request' },
      DOCS,
    ).hints;
    expect(open.base).toEqual({ chips: [] });
  });

  it('says the default types run when no listener narrows the types, and what runs a listener that names none', () => {
    const wide: Outline = {
      ...outline,
      workflows: [{ ...outline.workflows[0]!, events: [{ event: 'pull_request' }] }],
    };
    expect(deriveForm(wide, { event: 'pull_request' }, CI).hints.action?.text).toBe(
      'no workflow narrows types:, so the default types run',
    );
    const mixed: Outline = {
      ...outline,
      workflows: [outline.workflows[0]!, { ...outline.workflows[1]!, events: [{ event: 'pull_request' }] }],
    };
    expect(deriveForm(mixed, { event: 'pull_request' }, CI).hints.action?.text).toBe(
      'types: opened, closed; a workflow without types: runs on the default types',
    );
  });

  it('groups the dispatch inputs by the workflow that declares them, the focused one first', () => {
    const { dispatch } = form({ event: 'workflow_dispatch' }, '.github/workflows/after.yml');
    expect(dispatch.map((d) => [d.title, d.inputs.map((i) => i.name)])).toEqual([
      ['After', ['target']],
      ['CI', ['dry', 'env']],
    ]);
  });

  it('routes each refusal to the field that shows its key, and sums up the rest', () => {
    const issue = (path: (string | number)[], message: string) => ({ path, message });
    const push = routeIssues(
      [
        issue(['branch'], 'a'),
        issue(['tag'], 'b'),
        issue([], 'give one of ref, branch or tag'),
        issue(['cron'], 'c'),
        issue(['actor', 'login'], 'd'),
        issue(['actor'], 'e'),
        issue(['changed', 0], 'f'),
        issue(['constructor'], 'g'),
      ],
      form({ event: 'push' }).fields,
    );
    expect(Object.fromEntries(push.byField)).toEqual({ ref: 'a; b', 'actor.login': 'd; e', changed: 'f' });
    expect(push.summary.map((i) => i.message)).toEqual(['give one of ref, branch or tag', 'c', 'g']);
    const pr = routeIssues(
      [issue(['actor', 'fork'], 'h'), issue(['merged'], 'i')],
      form({ event: 'pull_request' }).fields,
    );
    expect(Object.fromEntries(pr.byField)).toEqual({ fork: 'h', merged: 'i' });
    const dispatch = routeIssues(
      [issue(['inputs', 'env'], 'j'), issue(['inputs', 'nope'], 'k')],
      form({ event: 'workflow_dispatch' }).fields,
    );
    expect(Object.fromEntries(dispatch.byField)).toEqual({ 'inputs.env': 'j', inputs: 'nope: k' });
    const advanced = routeIssues(
      [issue(['vars', 'DEPLOY'], 'o'), issue(['vars'], 'p'), issue(['changed', 0], 'q')],
      form({ event: 'push' }).fields,
    );
    expect(Object.fromEntries(advanced.byField)).toEqual({ vars: 'DEPLOY: o; p', changed: 'q' });
    const run = routeIssues(
      [issue(['workflow_run', 'name'], 'l'), issue(['workflow_run', 'branch'], 'm')],
      form({ event: 'workflow_run' }).fields,
    );
    expect(Object.fromEntries(run.byField)).toEqual({ workflow_run: 'l', 'workflow_run.branch': 'm' });
    const release = routeIssues([issue(['ref'], 'n')], form({ event: 'release' }).fields);
    expect(Object.fromEntries(release.byField)).toEqual({ tag: 'n' });
    expect(routeIssues([], form({ event: 'push' }).fields).summary).toEqual([]);
  });
});

describe('the aria of a field', () => {
  const ids = fieldIds('f1');

  it('points only at what the field shows', () => {
    expect(ids).toEqual({ id: 'f1', hint: 'f1-hint', error: 'f1-error', assumed: 'f1-assumed' });
    expect(fieldAria(ids, {})).toEqual({ id: 'f1' });
    expect(fieldAria(ids, { hint: 'a hint', assumed: true })).toEqual({
      id: 'f1',
      'aria-describedby': 'f1-hint f1-assumed',
    });
    expect(fieldAria(ids, { hint: '', issue: 'refused' })).toEqual({
      id: 'f1',
      'aria-invalid': true,
      'aria-errormessage': 'f1-error',
    });
  });
});

/** The lab repository, read the way the page reads a folder, and its outline from the worker. */
function labOutline(): Outline {
  const root = join(import.meta.dirname, '../../../fixtures/routes-lab/repo');
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else files[rel] = readFileSync(join(dir, entry.name), 'utf8');
    }
  };
  walk(root, '');
  const loaded = handle(initialState(), { id: 1, type: 'load', files });
  if (loaded.response.type !== 'loaded') throw new Error(loaded.response.type);
  return loaded.response.outline;
}

describe('the derived form over the lab repository', () => {
  const lab = labOutline();
  const chipped: HintKey[] = ['branch', 'tag', 'base', 'workflow_run.branch', 'changed'];

  it("offers only chips the engine's matcher selects with the pattern they come from", () => {
    let chips = 0;
    for (const w of lab.workflows)
      for (const e of w.events) {
        const { hints, groups } = deriveForm(lab, { event: e.event }, w.path);
        expect(groups[0]).toBe('event');
        expect(groups.at(-1)).toBe('advanced');
        for (const key of chipped)
          for (const chip of hints[key]?.chips ?? []) {
            chips++;
            expect(matchesPatterns(chip.value, [chip.pattern]), `${w.path} ${key}: ${chip.pattern}`).toBe(
              true,
            );
          }
      }
    expect(chips).toBeGreaterThan(5);
  });
});

/** A repository's outline from the worker, and each workflow's events as the engine's matcher reads them. */
function loadRepo(files: Record<string, string>) {
  const result = handle(initialState(), { id: 1, type: 'load', files });
  if (result.response.type !== 'loaded') throw new Error(result.response.type);
  const events = Object.entries(files).map(([path, text]) => readSettings(path, text).events);
  return { outline: result.response.outline, events };
}

const workflow = (on: string) => `on:\n${on}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n`;

describe('the activity types over workflows the engine reads', () => {
  const repos: Record<string, Record<string, string>> = {
    'no listener narrows': { '.github/workflows/a.yml': workflow('  pull_request:') },
    'one narrows, one does not': {
      '.github/workflows/a.yml': workflow('  pull_request:\n    types: [labeled]'),
      '.github/workflows/b.yml': workflow('  pull_request:'),
    },
    'every listener narrows': {
      '.github/workflows/a.yml': workflow('  pull_request:\n    types: [labeled, closed]'),
    },
    'custom types': { '.github/workflows/a.yml': workflow('  repository_dispatch:\n    types: [deploy]') },
  };

  it.each(Object.entries(repos))(
    'offers first what some workflow runs on and marks only what none does (%s)',
    (_, files) => {
      const { outline: o, events } = loadRepo(files);
      const event = Object.keys(events[0]!)[0]!;
      const types = deriveForm(o, { event }, undefined).activity!;
      const verdicts = (action?: string) =>
        events.map(
          (e) => matchTrigger(e, parseScenario(action ? { event, action } : { event })).decision.verdict,
        );
      for (const t of types.allowed) expect(verdicts(t), t).toContain('yes');
      for (const t of types.rest) expect(verdicts(t), t).not.toContain('yes');
      expect(verdicts().includes('maybe')).toBe(types.required);
    },
  );

  it('gives custom types a field of their own, so an action a pin adds can be seen and changed', () => {
    const { outline: o } = loadRepo(repos['custom types']!);
    const model = deriveForm(o, { event: 'repository_dispatch', action: 'deploy' }, undefined);
    expect(model.groups).toEqual(['event', 'activityType', 'advanced']);
    expect(model.activity).toEqual({ allowed: ['deploy'], rest: [], required: true, custom: true });
    expect(model.hints.action?.text).toBe('types: deploy');
    const open = loadRepo({ '.github/workflows/a.yml': workflow('  repository_dispatch:') }).outline;
    expect(deriveForm(open, { event: 'repository_dispatch' }, undefined).activity).toBeUndefined();
  });

  it('leaves a custom type no listener names a question worth asking: it skips the narrowed, runs the open', () => {
    const { outline: o, events } = loadRepo({
      '.github/workflows/a.yml': workflow('  repository_dispatch:\n    types: [deploy]'),
      '.github/workflows/b.yml': workflow('  repository_dispatch:'),
    });
    const scenario = { event: 'repository_dispatch', action: 'build' };
    expect(deriveForm(o, scenario, undefined).activity).toMatchObject({ allowed: ['deploy'], custom: true });
    const verdicts = events.map((e) => matchTrigger(e, parseScenario(scenario)).decision.verdict);
    expect(verdicts).toEqual(['no', 'yes']);
  });
});
