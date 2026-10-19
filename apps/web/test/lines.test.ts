import { SKIP_MARKERS as ENGINE_SKIP_MARKERS } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import {
  type ActivityTypes,
  activityNotes,
  actorWith,
  advancedSeen,
  advancedSet,
  choiceValue,
  mergedPatch,
  mergedValue,
  pushRef,
  SKIP_MARKERS,
  skipsCi,
  stray,
  strayFork,
  withEvent,
  withInput,
  withRunBranch,
  withSkipCi,
} from '../src/scenario/form';
import { kept } from '../src/scenario/keep';
import {
  namesText,
  parseNames,
  parseVars,
  sameNames,
  sameVars,
  varsText,
  withLine,
} from '../src/scenario/lines';

describe('the line fields', () => {
  it('read variables as name=value lines', () => {
    expect(parseVars('')).toBeUndefined();
    expect(parseVars('\n  \n=x\n')).toBeUndefined();
    expect(parseVars('DEPLOY=true\n EMPTY \nURL = https://x?a=b\nDEPLOY=false')).toEqual({
      DEPLOY: 'false',
      EMPTY: '',
      URL: 'https://x?a=b',
    });
    const own = parseVars('__proto__=x\nconstructor=y');
    expect(Object.keys(own!)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(own)).toBe(Object.prototype);
  });

  it('write variables back as lines, a value of the wrong shape as its JSON', () => {
    expect(varsText({ A: '1', B: '' })).toBe('A=1\nB=');
    expect(varsText({ A: 3, B: { c: 1 } })).toBe('A=3\nB={"c":1}');
    expect(varsText(undefined)).toBe('');
    expect(varsText(['A'])).toBe('');
    expect(varsText(null)).toBe('');
  });

  it('tell whether a text spells the variables, whatever its spacing', () => {
    expect(sameVars('A=1\n\n', { A: '1' })).toBe(true);
    expect(sameVars(' A = 1 ', { A: '1' })).toBe(true);
    expect(sameVars('', undefined)).toBe(true);
    expect(sameVars('A=1', { A: '2' })).toBe(false);
    expect(sameVars('', {})).toBe(false);
  });

  it('read names one per line, each once', () => {
    expect(parseNames('')).toBeUndefined();
    expect(parseNames(' NPM_TOKEN \n\nNPM_TOKEN\nDEPLOY_KEY')).toEqual(['NPM_TOKEN', 'DEPLOY_KEY']);
    expect(namesText(['a', 'b'])).toBe('a\nb');
    expect(namesText([1, null])).toBe('1\nnull');
    expect(namesText('a')).toBe('');
    expect(sameNames('a\n', ['a'])).toBe(true);
    expect(sameNames('a\na', ['a'])).toBe(true);
    expect(sameNames('a', ['b'])).toBe(false);
  });

  it('add a line once, on a line of its own', () => {
    expect(withLine('', 'src/a.ts')).toBe('src/a.ts');
    expect(withLine('x.ts', 'src/a.ts')).toBe('x.ts\nsrc/a.ts');
    expect(withLine('x.ts\n', 'src/a.ts')).toBe('x.ts\nsrc/a.ts');
    expect(withLine('x.ts\n src/a.ts ', 'src/a.ts')).toBe('x.ts\n src/a.ts ');
  });
});

describe('the field writes', () => {
  it('change one fact of the actor and keep the rest', () => {
    expect(actorWith(undefined, 'fork', true)).toEqual({ fork: true });
    expect(actorWith({ login: 'octo' }, 'fork', true)).toEqual({ login: 'octo', fork: true });
    expect(actorWith({ login: 'octo', fork: true }, 'fork', false)).toEqual({ login: 'octo' });
    expect(actorWith({ fork: true }, 'fork', false)).toBeUndefined();
    expect(actorWith({ bot: true }, 'login', '')).toEqual({ bot: true });
    expect(actorWith({ bot: true }, 'login', 'dependabot[bot]')).toEqual({
      bot: true,
      login: 'dependabot[bot]',
    });
  });

  it('tell when the scenario sets a key the Advanced rows show', () => {
    expect(advancedSet({ event: 'push' })).toBe(false);
    expect(advancedSet({ event: 'pull_request', actor: { fork: true }, vars: {}, secrets: [] })).toBe(false);
    expect(advancedSet({ event: 'push', actor: { fork: true } })).toBe(true);
    expect(advancedSet({ event: 'push', ref: 'refs/pull/7/merge' })).toBe(true);
    expect(advancedSet({ event: 'push', actor: { login: 'octo' } })).toBe(true);
    expect(advancedSet({ event: 'push', actor: { bot: false } })).toBe(true);
    expect(advancedSet({ event: 'push', vars: { A: '' } })).toBe(true);
    expect(advancedSet({ event: 'push', secrets: ['A'] })).toBe(true);
    expect(advancedSet({ event: 'push', sha: 'abc1234' })).toBe(true);
    expect(advancedSet({ event: 'push', platform: 'ghes' })).toBe(true);
  });

  it("set and clear the triggering run's branch", () => {
    expect(withRunBranch({ name: 'CI' }, 'main')).toEqual({ name: 'CI', branch: 'main' });
    expect(withRunBranch({ name: 'CI', branch: 'main', conclusion: 'failure' }, '')).toEqual({
      name: 'CI',
      conclusion: 'failure',
    });
  });

  it('set an input by its own name and drop the inputs when none is left', () => {
    expect(withInput(undefined, 'dry', true)).toEqual({ dry: true });
    expect(withInput({ dry: true, env: 'prod' }, 'dry', undefined)).toEqual({ env: 'prod' });
    expect(withInput({ dry: true }, 'dry', undefined)).toBeUndefined();
    const own = withInput({}, '__proto__', 'x');
    expect(Object.keys(own!)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(own)).toBe(Object.prototype);
  });

  it('show a value none of the options holds', () => {
    expect(stray(['a', 'b'], 'c')).toBe('c');
    expect(stray(['a', 'b'], 'a')).toBeUndefined();
    expect(stray(['a'], '')).toBeUndefined();
    expect(stray(['a'], undefined)).toBeUndefined();
    expect(stray(['a'], 3)).toBeUndefined();
  });

  it("read the engine's skip markers", () => {
    expect(SKIP_MARKERS).toEqual(ENGINE_SKIP_MARKERS);
    expect(skipsCi(undefined)).toBe(false);
    expect(skipsCi('fix: x')).toBe(false);
    expect(skipsCi('fix: x [ci skip]')).toBe(true);
    expect(skipsCi('fix: x\n\nskip-checks: true')).toBe(true);
    expect(skipsCi('fix: x\n\nskip-checks: false')).toBe(false);
  });

  it('add [skip ci] to the subject and take every marker out', () => {
    expect(withSkipCi(undefined, true)).toBe('[skip ci]');
    expect(withSkipCi('fix: x ', true)).toBe('fix: x [skip ci]');
    expect(withSkipCi('fix: x\n\nbody', true)).toBe('fix: x [skip ci]\n\nbody');
    expect(withSkipCi('fix: x [no ci]', true)).toBe('fix: x [no ci]');
    expect(withSkipCi('fix: x [skip ci]', false)).toBe('fix: x');
    expect(withSkipCi('[skip ci]', false)).toBeUndefined();
    expect(withSkipCi('fix: [ci skip] x [skip actions]\n\nskip-checks: true\n', false)).toBe('fix: x');
    expect(withSkipCi('fix: x', false)).toBe('fix: x');
    expect(withSkipCi(undefined, false)).toBeUndefined();
  });
});

describe('the reads the engine makes of a field', () => {
  it('keep a fork with the pull-request events, whose head it is, and leave it behind elsewhere', () => {
    const pr = { event: 'pull_request', base: 'main', actor: { login: 'octo', fork: true } };
    expect(withEvent(pr, 'pull_request_target').actor).toEqual({ login: 'octo', fork: true });
    expect(withEvent(pr, 'push')).toEqual({ event: 'push', base: 'main', actor: { login: 'octo' } });
    expect(withEvent({ event: 'pull_request', actor: { fork: true } }, 'push')).toEqual({ event: 'push' });
    expect(strayFork({ event: 'push', actor: { fork: true } })).toBe(true);
    expect(strayFork({ event: 'merge_group', actor: { fork: true } })).toBe(false);
    expect(strayFork({ event: 'push', actor: { login: 'octo' } })).toBe(false);
  });

  it('read a ref that is neither a branch nor a tag as no name, for the Ref row to show as it is', () => {
    expect(pushRef({ event: 'push', ref: 'refs/pull/7/merge' })).toEqual({ name: '' });
    expect(pushRef({ event: 'push', ref: 'pull/7/merge' })).toEqual({ name: '' });
    expect(pushRef({ event: 'push', ref: 'refs/main' })).toEqual({ name: '' });
    expect(pushRef({ event: 'push', ref: 'refs/heads/pull/7' })).toEqual({ kind: 'branch', name: 'pull/7' });
  });

  it('tell merged, not merged and unknown apart, since the engine reads no merged as unknown', () => {
    expect(mergedValue(undefined)).toBe('');
    expect(mergedValue(true)).toBe('true');
    expect(mergedValue(false)).toBe('false');
    expect(mergedPatch('')).toBeUndefined();
    expect(mergedPatch('true')).toBe(true);
    expect(mergedPatch('false')).toBe(false);
  });

  it("read a choice input's value as the text the engine coerces it to", () => {
    expect(choiceValue(undefined)).toBe('');
    expect(choiceValue('low')).toBe('low');
    expect(choiceValue(true)).toBe('true');
    expect(choiceValue(3)).toBe('3');
  });

  it('say what marks a type no workflow runs on, and an action that is none of the types', () => {
    const table = { allowed: ['opened'], rest: ['labeled'], required: false };
    expect(activityNotes(table, 'pull_request')).toEqual({
      rest: 'not a default type',
      stray: 'not a type of pull_request',
    });
    expect(activityNotes({ ...table, required: true }, 'pull_request').rest).toBe('not in types:');
    const custom: ActivityTypes = { allowed: ['deploy'], rest: [], required: true, custom: true };
    expect(activityNotes(custom, 'repository_dispatch').stray).toBe('not in types:');
  });

  it('open Advanced on a key newly set or a refusal not yet shown, and not again on one it showed', () => {
    const none = { set: false, refusal: '' };
    expect(advancedSeen(none, true, '')).toEqual({ seen: { set: true, refusal: '' }, opens: true });
    expect(advancedSeen({ set: true, refusal: '' }, true, '').opens).toBe(false);
    const refused = advancedSeen({ set: true, refusal: '' }, true, 'sha: bad');
    expect(refused).toEqual({ seen: { set: true, refusal: 'sha: bad' }, opens: true });
    const cleared = advancedSeen(refused.seen, true, '');
    expect(cleared).toEqual({ seen: { set: true, refusal: 'sha: bad' }, opens: false });
    expect(advancedSeen(cleared.seen, true, 'sha: bad').opens).toBe(false);
    expect(advancedSeen(cleared.seen, true, 'repository: bad').opens).toBe(true);
  });
});

describe('a field kept in view', () => {
  it('stays while the author empties what showed it, until the key changes', () => {
    const shown = kept({ key: 'merge_group', on: false }, 'merge_group', true, false);
    expect(shown).toEqual({ key: 'merge_group', on: true });
    expect(kept(shown, 'merge_group', false, true)).toBe(shown);
    expect(kept(shown, 'push', false, true)).toEqual({ key: 'push', on: false });
    expect(kept({ key: 'a', on: false }, 'a', true, true)).toEqual({ key: 'a', on: true });
    expect(kept({ key: 'a', on: false }, 'a', false, true)).toEqual({ key: 'a', on: false });
  });

  it('decides afresh on a scenario from outside', () => {
    const shown = { key: 'merge_group', on: true };
    expect(kept(shown, 'merge_group', false, false)).toEqual({ key: 'merge_group', on: false });
    expect(kept(shown, 'merge_group', true, false)).toBe(shown);
  });
});
