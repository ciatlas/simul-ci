import { describe, expect, it } from 'vitest';
import { deriveForm } from '../src/scenario/derive';
import {
  type NextFrame,
  opensFor,
  requestedField,
  resolveField,
  retryFrames,
  selectionFor,
  textOf,
} from '../src/scenario/focus';
import type { Outline } from '../src/worker/protocol';

const outline: Outline = {
  files: [],
  workflows: [
    {
      path: '.github/workflows/ci.yml',
      name: 'CI',
      callable: false,
      events: [
        { event: 'push', paths: ['src/**'] },
        { event: 'workflow_run', workflows: ['CI'] },
      ],
      dispatch: [{ name: 'deploy', type: 'boolean', required: false, default: false }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: {},
};

const fieldsOf = (event: string) => deriveForm(outline, { event }, undefined).fields;

describe('the field a focus request lands on', () => {
  it("takes the path's own field, as the worker's issues are routed", () => {
    const push = fieldsOf('push');
    expect(resolveField({ path: 'vars' }, push)).toBe('vars');
    expect(resolveField({ path: 'changed' }, push)).toBe('changed');
    expect(resolveField({ path: 'branch' }, push)).toBe('ref');
    expect(resolveField({ path: 'actor.login' }, push)).toBe('actor.login');
    expect(resolveField({ path: 'actor' }, push)).toBe('actor.login');
    expect(resolveField({ path: 'inputs.deploy' }, fieldsOf('workflow_dispatch'))).toBe('inputs.deploy');
    expect(resolveField({ path: 'workflow_run.branch' }, fieldsOf('workflow_run'))).toBe(
      'workflow_run.branch',
    );
  });

  it("falls back to the field of the path's key", () => {
    expect(resolveField({ path: 'workflow_run.name' }, fieldsOf('workflow_run'))).toBe('workflow_run');
    expect(resolveField({ path: 'actor.name' }, fieldsOf('push'))).toBe('actor.login');
    expect(resolveField({ path: 'inputs.other' }, fieldsOf('workflow_dispatch'))).toBe('inputs');
  });

  it('is none when the form shows no field for the path', () => {
    const push = fieldsOf('push');
    expect(resolveField({ path: 'cron' }, push)).toBeUndefined();
    expect(resolveField({ path: 'inputs.deploy' }, push)).toBeUndefined();
    expect(resolveField({ path: 'github.sha' }, push)).toBeUndefined();
  });
});

describe('a closed group a focus request opens', () => {
  it('opens for a request for one of its fields, once per request', () => {
    const push = deriveForm(outline, { event: 'push' }, undefined);
    const repository = requestedField({ path: 'repository', seq: 4 }, push.fields);
    expect(repository).toEqual({ field: 'repository', seq: 4 });
    expect(opensFor(repository, push.advanced, undefined)).toBe(4);
    expect(opensFor(repository, push.advanced, 3)).toBe(4);
    expect(opensFor(repository, push.advanced, 4)).toBeUndefined();
    expect(opensFor(requestedField({ path: 'actor', seq: 5 }, push.fields), push.advanced, 4)).toBe(5);
  });

  it('stays as it is for a request of another field, one the form does not show, or none', () => {
    const push = deriveForm(outline, { event: 'push' }, undefined);
    expect(opensFor(requestedField({ path: 'changed', seq: 1 }, push.fields), push.advanced, undefined)).toBe(
      undefined,
    );
    expect(requestedField({ path: 'cron', seq: 2 }, push.fields)).toBeUndefined();
    expect(requestedField(undefined, push.fields)).toBeUndefined();
    expect(opensFor(undefined, push.advanced, undefined)).toBeUndefined();
  });
});

describe('what the focus selects', () => {
  it("puts the caret right after a variable's = when its value is empty", () => {
    expect(selectionFor('vars', 'DEPLOY', 'DEPLOY=')).toEqual([7, 7]);
    expect(selectionFor('vars', 'DEPLOY', 'REGION=eu\nDEPLOY=')).toEqual([17, 17]);
    expect(selectionFor('vars', 'DEPLOY', 'DEPLOY=  \nREGION=eu')).toEqual([7, 7]);
  });

  it("selects a variable's value, without the spaces around it", () => {
    const text = 'REGION=eu\nDEPLOY=true\nLEVEL=high';
    const [start, end] = selectionFor('vars', 'DEPLOY', text)!;
    expect(text.slice(start, end)).toBe('true');
    const spaced = ' DEPLOY =  on air \n';
    const [from, to] = selectionFor('vars', 'DEPLOY', spaced)!;
    expect(spaced.slice(from, to)).toBe('on air');
  });

  it('selects the line parseVars keeps when two name the variable', () => {
    const text = 'DEPLOY=a\nDEPLOY=b';
    const [start, end] = selectionFor('vars', 'DEPLOY', text)!;
    expect([start, text.slice(start, end)]).toEqual([16, 'b']);
  });

  it('puts the caret at the end of a line naming the variable without =, or of the text when none names it', () => {
    expect(selectionFor('vars', 'DEPLOY', 'DEPLOY  \nREGION=eu')).toEqual([6, 6]);
    expect(selectionFor('vars', 'DEPLOY', 'REGION=eu')).toEqual([9, 9]);
    expect(selectionFor('vars', 'DEPLOY', 'DEPLOYMENT=x')).toEqual([12, 12]);
    expect(selectionFor('vars', 'DEPLOY', '')).toEqual([0, 0]);
  });

  it('selects the whole text of any other field, or of the variables when no entry is named', () => {
    expect(selectionFor('changed', undefined, 'src/a.ts\nsrc/b.ts')).toEqual([0, 17]);
    expect(selectionFor('changed', 'src/a.ts', 'src/a.ts')).toEqual([0, 8]);
    expect(selectionFor('vars', undefined, 'DEPLOY=true')).toEqual([0, 11]);
    expect(selectionFor('sha', undefined, '')).toEqual([0, 0]);
  });

  it('selects nothing in a control that holds no text', () => {
    expect(selectionFor('action', undefined, undefined)).toBeUndefined();
    expect(selectionFor('vars', 'DEPLOY', undefined)).toBeUndefined();
  });

  it('reads the text of text inputs and textareas only', () => {
    expect(textOf({ type: 'text', value: 'main' })).toBe('main');
    expect(textOf({ type: 'textarea', value: 'a\nb' })).toBe('a\nb');
    expect(textOf({ type: 'number', value: '3' })).toBeUndefined();
    expect(textOf({ type: 'checkbox', value: 'on' })).toBeUndefined();
    expect(textOf({ type: 'select-one', value: 'opened' })).toBeUndefined();
  });
});

/** Frames run by hand: `run()` fires the frame waiting, if any. */
function manualFrames() {
  let waiting: (() => void) | undefined;
  let asked = 0;
  const next: NextFrame = (callback) => {
    asked += 1;
    waiting = callback;
    return () => {
      if (waiting === callback) waiting = undefined;
    };
  };
  const run = (): boolean => {
    const callback = waiting;
    waiting = undefined;
    callback?.();
    return callback !== undefined;
  };
  return { next, run, asked: () => asked };
}

describe('the frames the form waits for a field', () => {
  it('tries on each frame until the attempt succeeds, then is done', () => {
    const frames = manualFrames();
    const tries: number[] = [];
    let done = 0;
    retryFrames(
      () => {
        tries.push(tries.length);
        return tries.length === 3;
      },
      () => (done += 1),
      10,
      frames.next,
    );
    expect(tries).toEqual([]);
    frames.run();
    frames.run();
    expect(done).toBe(0);
    frames.run();
    expect([tries.length, done]).toEqual([3, 1]);
    expect(frames.run()).toBe(false);
  });

  it('is done after the last frame though no attempt succeeded', () => {
    const frames = manualFrames();
    let tries = 0;
    let done = 0;
    retryFrames(
      () => {
        tries += 1;
        return false;
      },
      () => (done += 1),
      4,
      frames.next,
    );
    while (frames.run());
    expect([tries, done, frames.asked()]).toEqual([4, 1, 4]);
  });

  it('stops waiting without being done', () => {
    const frames = manualFrames();
    let tries = 0;
    let done = 0;
    const stop = retryFrames(
      () => {
        tries += 1;
        return false;
      },
      () => (done += 1),
      4,
      frames.next,
    );
    frames.run();
    stop();
    expect(frames.run()).toBe(false);
    expect([tries, done]).toEqual([1, 0]);
  });
});
