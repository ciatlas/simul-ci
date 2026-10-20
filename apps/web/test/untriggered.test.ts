import type { ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { untriggeredNote } from '../src/app/untriggered';
import { sampleByName } from '../src/input/samples';
import type { PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';
import type { Outline } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';
const starter = sampleByName('starter')!.files;

/** The starter with ci.yml's push filtered to release branches, simulated with ci.yml planned untriggered. */
function planned(
  scenario: ScenarioInput,
  untriggered: string[] = [CI],
): { plan: PlanState; outline: Outline } {
  const files = { ...starter, [CI]: starter[CI]!.replace('branches: [main]', 'branches: [release/**]') };
  const loaded = handle(initialState(), { id: 1, type: 'load', files });
  if (loaded.response.type !== 'loaded') throw new Error(loaded.response.type);
  const r = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
    planUntriggered: untriggered,
  });
  if (r.response.type !== 'plan') throw new Error(r.response.type);
  const { plan, derived, text, ms } = r.response;
  return {
    plan: { plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1 } },
    outline: loaded.response.outline,
  };
}

describe('the untriggered banner', () => {
  it('says what did not trigger the workflow, in the CLI’s clause, and offers its first other event', () => {
    const push = { event: 'push', branch: 'main' };
    const { plan, outline } = planned(push);
    expect(untriggeredNote(plan, CI, outline, push)).toEqual({
      by: 'push to main',
      clause: 'branches [release/**] ← main: false',
      instead: 'pull_request',
    });
    // An event the workflow does not list: its first event is the way back.
    const issues = { event: 'issues' };
    const other = planned(issues);
    expect(untriggeredNote(other.plan, CI, other.outline, issues)).toEqual({
      by: 'issues',
      clause: 'no on: issues',
      instead: 'push',
    });
  });

  it('says nothing for a triggered workflow, another focus, or a plan without its jobs', () => {
    const pr = { event: 'pull_request', base: 'main' };
    const triggered = planned(pr);
    expect(untriggeredNote(triggered.plan, CI, triggered.outline, pr)).toBeUndefined();
    const push = { event: 'push', branch: 'main' };
    const { plan, outline } = planned(push);
    expect(untriggeredNote(plan, '.github/workflows/release.yml', outline, push)).toBeUndefined();
    const shell = planned(push, []);
    expect(untriggeredNote(shell.plan, CI, shell.outline, push)).toBeUndefined();
    expect(untriggeredNote(undefined, CI, outline, push)).toBeUndefined();
  });
});
