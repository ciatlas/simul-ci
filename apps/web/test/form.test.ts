import { describe, expect, it } from 'vitest';
import {
  activityTypes,
  changedText,
  crons,
  dispatchInputs,
  jsonText,
  parseChanged,
  pathPatterns,
  withEvent,
  workflowNames,
} from '../src/scenario/form';
import { reportText } from '../src/state/report';
import { urlSliceChanged, urlStateOf } from '../src/state/url';
import type { Outline } from '../src/worker/protocol';

const outline: Outline = {
  files: [],
  workflows: [
    {
      path: '.github/workflows/ci.yml',
      name: 'CI',
      callable: false,
      events: [
        {
          event: 'pull_request',
          types: { allowed: ['opened', 'labeled'], all: ['opened', 'labeled', 'closed'], narrowed: true },
        },
        { event: 'push', paths: ['src/**'], pathsIgnore: ['docs/**'] },
        { event: 'schedule', crons: ['0 6 * * 1'] },
      ],
      dispatch: [
        { name: 'env', type: 'choice', required: false, default: 'staging', options: ['staging', 'prod'] },
        { name: 'dry', type: 'boolean', required: true },
      ],
      jobs: [],
      onLine: 1,
    },
    {
      path: '.github/workflows/nightly.yml',
      callable: false,
      events: [
        { event: 'pull_request' },
        { event: 'schedule', crons: ['0 2 * * *', '0 6 * * 1'] },
        { event: 'workflow_run', workflows: ['CI', 'Release'] },
      ],
      dispatch: [{ name: 'env', type: 'string', required: false }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: { pull_request: { types: ['opened', 'labeled', 'closed'], default: ['opened'] } },
};

describe('the form helpers', () => {
  it('keep the ref and the repository facts across an event change and drop the rest', () => {
    const next = withEvent(
      {
        event: 'pull_request',
        action: 'labeled',
        base: 'main',
        head: 'x',
        number: 3,
        inputs: { a: 1 },
        cron: 'x',
        vars: { A: '1' },
      },
      'push',
    );
    expect(next).toEqual({ event: 'push', base: 'main', head: 'x', number: 3, vars: { A: '1' } });
  });

  it('derive the activity types, the inputs, the crons, the names and the path patterns', () => {
    expect(activityTypes(outline, 'pull_request')).toEqual({
      allowed: ['opened', 'labeled'],
      rest: ['closed'],
      required: true,
    });
    expect(activityTypes({ ...outline, workflows: [outline.workflows[1]!] }, 'pull_request')).toEqual({
      allowed: ['opened', 'labeled', 'closed'],
      rest: [],
      required: false,
    });
    expect(activityTypes(outline, 'push')).toBeUndefined();
    expect(dispatchInputs(outline).map((i) => [i.name, i.type])).toEqual([
      ['env', 'choice'],
      ['dry', 'boolean'],
    ]);
    expect(crons(outline)).toEqual(['0 6 * * 1', '0 2 * * *']);
    expect(workflowNames(outline)).toEqual(['CI', 'Release']);
    expect(pathPatterns(outline, 'push')).toEqual(['src/**', 'docs/**']);
    expect(pathPatterns(outline, 'pull_request')).toEqual([]);
  });

  it('read and write the changed-files lines', () => {
    expect(parseChanged('')).toBeUndefined();
    expect(parseChanged('\n  \n')).toBeUndefined();
    expect(parseChanged('src/a.ts\n docs/b.md (added)\nold.ts (renamed from older.ts)\nx (moved)')).toEqual([
      'src/a.ts',
      { path: 'docs/b.md', status: 'added' },
      { path: 'old.ts', status: 'renamed', from: 'older.ts' },
      'x (moved)',
    ]);
    expect(changedText(parseChanged('a\nb (removed)\nc (renamed from d)'))).toBe(
      'a\nb (removed)\nc (renamed from d)',
    );
    expect(changedText(undefined)).toBe('');
    expect(jsonText('x')).toBe('x');
    expect(jsonText(true)).toBe('true');
  });

  it('tell the URL slice apart and spell it', () => {
    const base = {
      scenario: { event: 'push' },
      assume: [],
      detail: 'steps' as const,
      ui: { view: 'graph' as const, hideUntriggered: false },
    };
    expect(urlStateOf(base)).toEqual({ scenario: { event: 'push' }, assume: [] });
    expect(
      urlStateOf({ ...base, focus: 'ci.yml', detail: 'legs', ui: { view: 'text', hideUntriggered: true } }),
    ).toEqual({
      scenario: { event: 'push' },
      assume: [],
      wf: 'ci.yml',
      d: 'legs',
      view: 'text',
      hide: true,
    });
    expect(urlSliceChanged(base, base)).toBe(false);
    expect(urlSliceChanged({ ...base, scenario: { event: 'push' } }, base)).toBe(true);
    expect(urlSliceChanged({ ...base, ui: { ...base.ui, hideUntriggered: true } }, base)).toBe(true);
  });

  it('write a failure report without file contents', () => {
    const text = reportText({
      engine: { status: 'ready', version: '0.2.0', models: [], restarts: 1, busy: false },
      error: { kind: 'engine', message: 'boom', stack: 'at x' },
      scenario: { event: 'push' },
      assume: [{ step: 'a.b', outcome: 'failure' }],
      files: { '.github/workflows/ci.yml': 'secret: contents' },
    });
    expect(text).toContain('engine 0.2.0, protocol 1, restarts 1');
    expect(text).toContain('error: engine: boom\nat x');
    expect(text).toContain('files: .github/workflows/ci.yml (16 chars)');
    expect(text).not.toContain('contents');
  });
});
