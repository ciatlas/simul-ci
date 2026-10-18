import {
  becauseOf,
  decidingClause,
  decidingReason,
  type RunPlan,
  type ScenarioInput,
  simulate,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const wf = `
on:
  push:
    branches: [main]
    paths: ['src/**']
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: echo a }]
  b:
    needs: a
    if: github.actor == 'octocat'
    runs-on: ubuntu-latest
    steps: [{ run: echo b }]
`;
const run = (scenario: ScenarioInput): RunPlan =>
  simulate({ files: { '.github/workflows/ci.yml': wf }, scenario });
const triggered = (p: RunPlan) => p.workflows[0]!.triggered;

describe('decidingReason', () => {
  it('names the first gate that failed, not the last gate evaluated (a workflow chain holds every gate)', () => {
    const p = run({ event: 'push', branch: 'topic', changed: ['docs/a.md'] });
    const t = triggered(p);
    expect(t.verdict).toBe('no');
    expect(t.chain.map((r) => r.kind)).toEqual(['event', 'filter', 'filter']);
    expect(becauseOf(decidingReason(t.chain, t.verdict)!)).toBe('branches');
    expect(decidingClause(t)).toBe('branches [main] ← topic: false');
  });

  it('names the first undecided gate for a maybe', () => {
    const p = run({ event: 'push', branch: 'main' });
    const t = triggered(p);
    expect(t.verdict).toBe('maybe');
    expect(becauseOf(decidingReason(t.chain, t.verdict)!)).toBe('paths');
  });

  it('names the last reason for a yes, the parent for a child of a skipped unit, and if for the needs cascade', () => {
    const p = run({ event: 'push', branch: 'main', changed: ['src/a.ts'] });
    const t = triggered(p);
    expect(becauseOf(decidingReason(t.chain, t.verdict)!)).toBe('paths');
    const b = p.workflows[0]!.jobs[1]!;
    expect(b.runs.verdict).toBe('maybe');
    expect(becauseOf(decidingReason(b.runs.chain, b.runs.verdict)!)).toBe('if');
    const skipped = run({ event: 'pull_request' }).workflows[0]!;
    expect(becauseOf(decidingReason(skipped.triggered.chain, 'no')!)).toBe('event');
  });
});
