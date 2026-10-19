import {
  type AssumeEntry,
  AssumeEntrySchema,
  type ScenarioInput,
  SHIPPED_MODELS,
  type Unknown,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { sampleByName } from '../src/input/samples';
import { draftFor, draftOfEntry, entryProblems, entryYaml, type PinContext } from '../src/panels/pin-draft';
import { planNodes } from '../src/plan/nodes';
import { handle, initialState } from '../src/worker/handle';
import type { PlanResponse } from '../src/worker/protocol';

/** The worker's answer for the files under a scenario and a case layer. */
function simulated(
  files: Record<string, string>,
  scenario: ScenarioInput,
  assume: AssumeEntry[] = [],
): PlanResponse {
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
  return step.response;
}

/** The models as the worker's `ready` lists them. */
const models = SHIPPED_MODELS.map((m) => ({ id: m.id, version: m.version, presets: [...m.presets] }));
const contextOf = (r: PlanResponse): PinContext => ({ plan: r.plan, derived: r.derived, models });
const unknown = (id: string): Unknown => ({ id, kind: 'unsupported', reads: [], affects: [] });
const unknownIn = (r: PlanResponse, id: string): Unknown => {
  const u = r.plan.unknowns.find((x) => x.id === id);
  if (!u) throw new Error(`no unknown ${id} in ${r.plan.unknowns.map((x) => x.id).join(', ')}`);
  return u;
};

/** The verdict of the job, leg or step a unit path names. */
function verdictAt(r: PlanResponse, path: string): string | undefined {
  const id = Object.entries(r.derived.unitPaths).find(([, p]) => p === path)?.[0];
  const node = id === undefined ? undefined : planNodes(r.plan).get(id);
  if (!node || node.kind === 'workflow') return undefined;
  if (node.kind === 'job') return node.job.runs.verdict;
  if (node.kind === 'leg') return node.leg.runs.verdict;
  return node.step.runs.verdict;
}

const starter = sampleByName('starter')!.files;
const monorepo = sampleByName('monorepo')!.files;
const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const SETUP = `${RELEASE}#publish/~github-actions-setup>.github/actions/setup`;

/** Two workflows with a job `after` each: an entry for one names its workflow. */
const twins = {
  '.github/workflows/m.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - run: npm test
  after:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - id: write
        run: echo "MODE=$(cat mode)" >> "$GITHUB_ENV"
      - if: env.MODE == 'fast'
        run: echo fast
`,
  '.github/workflows/n.yml': `on: push
jobs:
  after:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
};
const M = '.github/workflows/m.yml';

/** A matrix job whose step after `detect` reads its output, on every leg. */
const detectIn = (matrix: string) => `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
${matrix}
    steps:
      - id: detect
        uses: acme/detect@v1
      - if: steps.detect.outputs.changed == 'true'
        run: npm test
`;

const PACKAGE = '.github/workflows/package.yml';

/** ci.yml calls package.yml from a job `web`; other.yml has a job `web` of its own. */
const shared = {
  [CI]: `on: push
jobs:
  web:
    uses: ./${PACKAGE}
`,
  '.github/workflows/other.yml': `on: push
jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - run: echo web
`,
  [PACKAGE]: `on: workflow_call
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with:
          path: node_modules
          key: deps
      - if: steps.cache.outputs.cache-hit != 'true'
        run: npm ci
`,
};

/** The step-output unknowns of the `detect` step, one per leg. */
const detectUnknowns = (r: PlanResponse): Unknown[] =>
  r.plan.unknowns.filter((u) => u.id.endsWith('/steps.detect.outputs.changed'));

describe('draftFor', () => {
  const push: ScenarioInput = { event: 'push', branch: 'main', changed: ['src/a.ts'] };
  const ci = simulated(starter, push);
  const tag = simulated(starter, { event: 'push', tag: 'v1.0.0' });

  it('drafts a step output an if: reads, and the value pinned decides the step', () => {
    const id = `${CI}#build/steps.detect.outputs.changed`;
    const draft = draftFor(unknownIn(ci, id), contextOf(ci));
    expect(draft).toEqual({
      entry: { step: 'build.detect', outputs: { changed: '' } },
      about: { field: 'outputs', name: 'changed' },
      outcomes: ['success', 'failure'],
      candidates: [],
    });
    expect(verdictAt(ci, 'build.#3')).toBe('maybe');
    const entry: AssumeEntry = { ...draft!.entry, outputs: { changed: 'true' } };
    expect(AssumeEntrySchema.safeParse(entry).success).toBe(true);
    const after = simulated(starter, push, [entry]);
    // The engine still lists the script's output as unknown; once pinned, it decides nothing.
    expect(after.plan.unknowns.find((u) => u.id === id)?.affects ?? []).toEqual([]);
    expect(verdictAt(after, 'build.#3')).toBe('yes');
    expect(after.plan.mocks).toContainEqual(
      expect.objectContaining({ ref: 'assume[0]', provides: ['outputs.changed'] }),
    );
    expect(after.plan.diagnostics).toEqual([]);
  });

  it("offers a model's candidates and presets for an inner step of a composite action", () => {
    const id = `${SETUP}/steps.cache.outputs.cache-hit`;
    const draft = draftFor(unknownIn(tag, id), contextOf(tag));
    expect(draft).toEqual({
      entry: { step: 'publish.#2/cache', outputs: { 'cache-hit': '' } },
      about: { field: 'outputs', name: 'cache-hit' },
      outcomes: ['success', 'failure'],
      candidates: ['true', 'false', ''],
      model: { id: 'actions/cache', presets: ['hit', 'partial', 'miss'] },
    });
    // The preset the model offers, written for the same unit, decides the step after it.
    const after = simulated(starter, { event: 'push', tag: 'v1.0.0' }, [
      { step: 'publish.#2/cache', as: 'hit' },
    ]);
    expect(after.plan.diagnostics).toEqual([]);
    expect(verdictAt(after, 'publish.#2/#3')).toBe('no');
  });

  it("drafts a composite action's own output on the step that uses it", () => {
    const draft = draftFor(unknown(`${SETUP}.outputs.dir`), contextOf(tag));
    expect(draft?.entry).toEqual({ step: 'publish.#2', outputs: { dir: '' } });
    expect(draft?.model).toBeUndefined();
  });

  it('drafts a job outcome, and the failure decides the jobs that need it', () => {
    const draft = draftFor(unknown(`${CI}#build.outcome`), contextOf(ci));
    expect(draft).toEqual({
      entry: { job: 'build', outcome: 'failure' },
      about: { field: 'outcome' },
      outcomes: ['success', 'failure', 'cancelled'],
      candidates: [],
    });
    expect(verdictAt(ci, 'deploy')).toBe('yes');
    const after = simulated(starter, push, [draft!.entry]);
    expect(verdictAt(after, 'deploy')).toBe('no');
    expect(after.plan.mocks).toContainEqual(
      expect.objectContaining({ ref: 'assume[0]', at: `${CI}#build`, provides: ['outcome'] }),
    );
  });

  it("drafts a leg's outcome with its values as matrix:, and a step outcome with two choices", () => {
    expect(draftFor(unknown(`${CI}#test[node=22].outcome`), contextOf(ci))?.entry).toEqual({
      job: 'test',
      matrix: { node: '22' },
      outcome: 'failure',
    });
    const step = draftFor(unknown(`${CI}#test[node=24]/~npm-test.outcome`), contextOf(ci));
    expect(step?.entry).toEqual({ step: 'test.#4', matrix: { node: '24' }, outcome: 'failure' });
    expect(step?.outcomes).toEqual(['success', 'failure']);
  });

  it('drafts a leg whose value holds a slash, and the entry decides that leg alone', () => {
    const files = { [CI]: detectIn('        node: [lts/*, 22]') };
    const r = simulated(files, { event: 'push', branch: 'main' });
    const lts = unknownIn(r, `${CI}#test[node=lts/*]/steps.detect.outputs.changed`);
    const draft = draftFor(lts, contextOf(r));
    expect(draft?.entry).toEqual({
      step: 'test.detect',
      matrix: { node: 'lts/*' },
      outputs: { changed: '' },
    });
    const entry: AssumeEntry = { ...draft!.entry, outputs: { changed: 'true' } };
    expect(AssumeEntrySchema.safeParse(entry).success).toBe(true);
    const after = simulated(files, { event: 'push', branch: 'main' }, [entry]);
    expect(after.plan.diagnostics).toEqual([]);
    expect(verdictAt(after, 'test[node=lts/*].#2')).toBe('yes');
    expect(verdictAt(after, 'test[node=22].#2')).toBe('maybe');
    expect(after.plan.mocks).toContainEqual(
      expect.objectContaining({ ref: 'assume[0]', provides: ['outputs.changed'] }),
    );
  });

  it('drafts a leg whose value is an object as its JSON, and the entry decides that leg alone', () => {
    const files = {
      [CI]: detectIn('        config: [{ os: ubuntu, arch: x64 }, { os: windows, arch: arm64 }]'),
    };
    const r = simulated(files, { event: 'push', branch: 'main' });
    const ubuntu = detectUnknowns(r).find((u) => u.id.includes('ubuntu'));
    const draft = draftFor(ubuntu!, contextOf(r));
    expect(draft?.entry).toEqual({
      step: 'test.detect',
      matrix: { config: '{"os":"ubuntu","arch":"x64"}' },
      outputs: { changed: '' },
    });
    const entry: AssumeEntry = { ...draft!.entry, outputs: { changed: 'true' } };
    const after = simulated(files, { event: 'push', branch: 'main' }, [entry]);
    expect(after.plan.diagnostics).toEqual([]);
    const affecting = detectUnknowns(after).filter((u) => u.affects.length > 0);
    expect(affecting.map((u) => u.id.includes('windows'))).toEqual([true]);
  });

  it("keeps a calling leg's values in the path, and drafts nothing when the path cannot hold them", () => {
    const files = {
      [CI]: `on: push
jobs:
  web:
    strategy:
      matrix:
        pkg: [web, apps/api]
    uses: ./${PACKAGE}
`,
      [PACKAGE]: detectIn('        node: [22]').replace('on: push', 'on: workflow_call'),
    };
    const r = simulated(files, { event: 'push', branch: 'main' });
    const [web, api] = ['pkg=web', 'pkg=apps/api'].map((leg) =>
      detectUnknowns(r).find((u) => u.id.includes(`#web[${leg}]>`)),
    );
    const draft = draftFor(web!, contextOf(r));
    expect(draft?.entry).toEqual({
      step: 'web[pkg=web]/test.detect',
      matrix: { node: '22' },
      outputs: { changed: '' },
    });
    const after = simulated(files, { event: 'push', branch: 'main' }, [
      { ...draft!.entry, outputs: { changed: 'true' } },
    ]);
    expect(after.plan.diagnostics).toEqual([]);
    expect(verdictAt(after, 'web[pkg=web]/test[node=22].#2')).toBe('yes');
    expect(verdictAt(after, 'web[pkg=apps/api]/test[node=22].#2')).toBe('maybe');
    expect(draftFor(api!, contextOf(r))).toBeUndefined();
  });

  it('drafts an env write for a step, naming the workflow when another has a job of the same id', () => {
    const r = simulated(twins, { event: 'push', branch: 'main' });
    const id = `${M}#after/steps.write.env.MODE`;
    const draft = draftFor(unknownIn(r, id), contextOf(r));
    expect(draft).toEqual({
      entry: { workflow: M, step: 'after.write', env: { MODE: '' } },
      about: { field: 'env', name: 'MODE' },
      outcomes: ['success', 'failure'],
      candidates: [],
    });
    const entry: AssumeEntry = { ...draft!.entry, env: { MODE: 'fast' } };
    const after = simulated(twins, { event: 'push', branch: 'main' }, [entry]);
    expect(after.plan.diagnostics).toEqual([]);
    expect(after.plan.unknowns.find((u) => u.id === id)?.affects ?? []).toEqual([]);
    expect(verdictAt(after, 'after.#2')).toBe('yes');
    // m.yml alone has a job `test`: no workflow.
    expect(draftFor(unknown(`${M}#test.outcome`), contextOf(r))?.entry).toEqual({
      job: 'test',
      outcome: 'failure',
    });
  });

  it('drafts no env write for a job, which only a step makes', () => {
    expect(draftFor(unknown(`${CI}#build.env.MODE`), contextOf(ci))).toBeUndefined();
  });

  it('drafts the output of a called workflow on the job that calls it', () => {
    const r = simulated(monorepo, {
      event: 'pull_request',
      base: 'main',
      head: 'x',
      changed: ['apps/web/a.ts'],
    });
    const draft = draftFor(unknown(`${CI}#web>.github/workflows/package.yml.outputs.ok`), contextOf(r));
    expect(draft?.entry).toEqual({ job: 'web', outputs: { ok: '' } });
    expect(draft?.outcomes).toEqual(['success', 'failure', 'cancelled']);
    expect(
      draftFor(unknown(`${CI}#web>.github/workflows/package.yml#test.outcome`), contextOf(r))?.entry,
    ).toEqual({
      job: 'web/test',
      outcome: 'failure',
    });
  });

  it("names a called workflow's unit by the file it is declared in, which the engine matches", () => {
    const r = simulated(shared, { event: 'push', branch: 'main' });
    const id = `${CI}#web>${PACKAGE}#test/steps.cache.outputs.cache-hit`;
    const draft = draftFor(unknownIn(r, id), contextOf(r));
    expect(draft).toEqual({
      entry: { workflow: PACKAGE, step: 'web/test.cache', outputs: { 'cache-hit': '' } },
      about: { field: 'outputs', name: 'cache-hit' },
      outcomes: ['success', 'failure'],
      candidates: ['true', 'false', ''],
      model: { id: 'actions/cache', presets: ['hit', 'partial', 'miss'] },
    });
    const entry: AssumeEntry = { ...draft!.entry, outputs: { 'cache-hit': 'true' } };
    const after = simulated(shared, { event: 'push', branch: 'main' }, [entry]);
    expect(after.plan.diagnostics).toEqual([]);
    expect(verdictAt(after, 'web/test.#2')).toBe('no');
    expect(after.plan.mocks).toContainEqual(expect.objectContaining({ ref: 'assume[0]' }));
    // Editing the entry finds the same unit, in the file the entry names.
    expect(draftOfEntry(entry, contextOf(r))).toEqual({ ...draft, entry, about: draft!.about });
  });

  it('drafts nothing for what names no step, leg or job', () => {
    const ctx = contextOf(ci);
    for (const id of [
      `race:fail-fast:${CI}#test[node=24]`,
      'vars.DEPLOY',
      'scenario.changed',
      `${CI}.outputs.x`,
      `${CI}#build.call`,
      `${CI}#test[node=22].matrix.node`,
      `${CI}#build/steps.detect.outputs`,
      `${CI}#nope.outcome`,
      'expression:success()',
    ])
      expect(draftFor(unknown(id), ctx), id).toBeUndefined();
  });
});

describe('draftOfEntry', () => {
  const ci = simulated(starter, { event: 'push', branch: 'main', changed: ['src/a.ts'] });
  const tag = simulated(starter, { event: 'push', tag: 'v1.0.0' });

  it('offers for an entry the author has what a draft for its unit offers, about its first field', () => {
    const entry: AssumeEntry = { step: 'publish.#2/cache', outputs: { 'cache-hit': 'true' } };
    expect(draftOfEntry(entry, contextOf(tag))).toEqual({
      entry,
      about: { field: 'outputs', name: 'cache-hit' },
      outcomes: ['success', 'failure'],
      candidates: ['true', 'false', ''],
      model: { id: 'actions/cache', presets: ['hit', 'partial', 'miss'] },
    });
    expect(draftOfEntry(entry, contextOf(tag)).entry).not.toBe(entry);
  });

  it('finds the unit within the workflow the entry names', () => {
    const entry: AssumeEntry = {
      workflow: 'release',
      step: 'publish.#2/cache',
      outputs: { 'cache-hit': 'true' },
    };
    expect(draftOfEntry(entry, contextOf(tag)).candidates).toEqual(['true', 'false', '']);
    expect(draftOfEntry({ ...entry, workflow: 'release.yml' }, contextOf(tag)).candidates).toHaveLength(3);
    expect(draftOfEntry({ ...entry, workflow: RELEASE }, contextOf(tag)).candidates).toHaveLength(3);
    const elsewhere = draftOfEntry({ ...entry, workflow: 'ci' }, contextOf(tag));
    expect(elsewhere.candidates).toEqual([]);
    expect(elsewhere.model).toBeUndefined();
  });

  it('finds the leg an entry names by its matrix values, as a draft writes them', () => {
    const files = {
      [CI]: detectIn('        node: [lts/*, 22]').replace('acme/detect@v1', 'actions/cache@v4'),
    };
    const r = simulated(files, { event: 'push', branch: 'main' });
    const lts = draftFor(unknownIn(r, `${CI}#test[node=lts/*]/steps.detect.outputs.cache-hit`), contextOf(r));
    expect(lts?.entry).toEqual({
      step: 'test.detect',
      matrix: { node: 'lts/*' },
      outputs: { 'cache-hit': '' },
    });
    expect(draftOfEntry(lts!.entry, contextOf(r))).toEqual(lts);
    // The path as written still names its leg; values no leg has name none.
    const bracketed = { step: 'test[node=22].detect', outputs: { 'cache-hit': 'true' } };
    expect(draftOfEntry(bracketed, contextOf(r)).model?.id).toBe('actions/cache');
    const none = { step: 'test.detect', matrix: { node: '20' }, outputs: { 'cache-hit': 'true' } };
    expect(draftOfEntry(none, contextOf(r)).candidates).toEqual([]);
  });

  it('is about an env write, then the outcome, when the entry states no output', () => {
    expect(
      draftOfEntry({ step: 'build.detect', env: { X: '1' }, outcome: 'failure' }, contextOf(ci)).about,
    ).toEqual({
      field: 'env',
      name: 'X',
    });
    const job = draftOfEntry({ job: 'test', matrix: { node: '24' }, outcome: 'cancelled' }, contextOf(ci));
    expect(job.about).toEqual({ field: 'outcome' });
    expect(job.outcomes).toEqual(['success', 'failure', 'cancelled']);
  });

  it('takes the model from a uses pattern, and offers for a unit the plan does not have', () => {
    const uses = draftOfEntry({ job: 'publish', uses: 'Actions/Cache@v4', as: 'miss' }, contextOf(tag));
    expect(uses.outcomes).toEqual(['success', 'failure']);
    expect(uses.model).toEqual({ id: 'actions/cache', presets: ['hit', 'partial', 'miss'] });
    expect(
      draftOfEntry({ uses: 'actions/cache/save', outcome: 'failure' }, contextOf(tag)).model,
    ).toBeUndefined();
    expect(draftOfEntry({ step: 'nope.x', outputs: { y: '' } }, contextOf(ci))).toEqual({
      entry: { step: 'nope.x', outputs: { y: '' } },
      about: { field: 'outputs', name: 'y' },
      outcomes: ['success', 'failure'],
      candidates: [],
    });
  });
});

describe('entryProblems', () => {
  const NAME = 'name a step, a job, or a uses pattern (with a job as its scope)';
  const refined: [AssumeEntry, string[]][] = [
    [{ step: 'a.b', outcome: 'failure' }, []],
    [{ job: 'a', outputs: { x: '1' } }, []],
    [{ uses: 'actions/cache', as: 'hit' }, []],
    [{ job: 'a', uses: 'actions/cache', env: { X: '1' } }, []],
    [{}, [NAME, 'state an outcome, outputs, env or as']],
    [{ step: 'a.b', job: 'a', outcome: 'failure' }, [NAME]],
    [{ step: 'a.b', uses: 'x/y', outcome: 'failure' }, [NAME]],
    [{ step: 'a.b' }, ['state an outcome, outputs, env or as']],
    [{ job: 'a', env: { X: '1' } }, ['env writes belong to a step']],
  ];

  it("words the schema's refinements as the schema does, and agrees with it", () => {
    for (const [entry, problems] of refined) {
      expect(entryProblems(entry), JSON.stringify(entry)).toEqual(problems);
      const parsed = AssumeEntrySchema.safeParse(entry);
      expect(parsed.success, JSON.stringify(entry)).toBe(problems.length === 0);
      if (!parsed.success) expect(parsed.error.issues.map((i) => i.message)).toEqual(problems);
    }
  });

  it('names an empty unit, preset or name', () => {
    expect(entryProblems({ step: ' ', outputs: { '': 'x' } })).toEqual([
      'the step is empty',
      'an output needs a name',
    ]);
    expect(entryProblems({ workflow: '', job: '', uses: '', as: '', env: { ' ': 'x' } })).toEqual([
      'the workflow is empty',
      'the job is empty',
      'the uses pattern is empty',
      'the preset is empty',
      'an env write needs a name',
    ]);
  });
});

describe('entryYaml', () => {
  it('writes one list item, keys in the order a test file writes them', () => {
    const entry: AssumeEntry = {
      env: { MODE: 'fast' },
      outputs: { changed: 'true', count: 3, ok: true, gone: { unknown: true } },
      outcome: 'failure',
      as: 'hit',
      matrix: { node: 22, os: 'ubuntu-latest' },
      uses: 'actions/cache@v4',
      job: 'test',
      workflow: 'ci.yml',
    };
    expect(entryYaml(entry)).toBe(
      [
        '- workflow: ci.yml',
        '  job: test',
        '  uses: actions/cache@v4',
        '  matrix:',
        '    node: 22',
        '    os: ubuntu-latest',
        '  as: hit',
        '  outcome: failure',
        '  outputs:',
        "    changed: 'true'",
        '    count: 3',
        '    ok: true',
        '    gone: { unknown: true }',
        '  env:',
        '    MODE: fast',
      ].join('\n'),
    );
    expect(parse(entryYaml(entry))).toEqual([entry]);
  });

  it('writes the draft of the starter step as a test file would', () => {
    expect(entryYaml({ step: 'build.detect', outputs: { changed: 'true' } })).toBe(
      "- step: build.detect\n  outputs:\n    changed: 'true'",
    );
    expect(entryYaml({ step: 'a.b', outputs: {} })).toBe('- step: a.b\n  outputs: {}');
    expect(entryYaml({})).toBe('- {}');
    expect(parse(entryYaml({}))).toEqual([{}]);
  });

  const quoted = [
    '',
    ' lead',
    'trail ',
    ...'-?:,[]{}#&*!|>\'"%@`'.split('').map((c) => `${c}x`),
    'a: b',
    'a #b',
    'a:',
    'true',
    'False',
    'YES',
    'no',
    'On',
    'off',
    'y',
    'N',
    'null',
    'NULL',
    '~',
    '1',
    '-2',
    '+3',
    '1.5',
    '.5',
    '1e3',
    '0x1F',
    '0o17',
    '0b101',
    '1_000',
    '1:20',
    '.inf',
    '-.Inf',
    '.NaN',
    "'quoted'",
  ];
  const plain = ['main', 'v1.0.0', '1.2.3', 'a:b', 'a#b', "it's", 'refs/heads/main', 'ubuntu-latest', 'x-y'];

  it('quotes a string YAML would read as something else, and leaves the rest plain', () => {
    for (const s of quoted) {
      const line = entryYaml({ step: 'a.b', outputs: { v: s } }).split('\n')[2];
      expect(line, s).toBe(`    v: '${s.replaceAll("'", "''")}'`);
    }
    for (const s of plain)
      expect(entryYaml({ step: 'a.b', outputs: { v: s } }).split('\n')[2], s).toBe(`    v: ${s}`);
  });

  it('round-trips every value through a YAML 1.2 and a YAML 1.1 parser', () => {
    const escaped = [
      'line\nbreak',
      'tab\there',
      'nul\u0000',
      'del\u007f',
      'c1\u0080',
      'nel\u0085',
      'ls\u2028',
      'bom\ufeff',
    ];
    for (const s of [...quoted, ...plain, ...escaped, '<<', 'emoji 🙂']) {
      const entry: AssumeEntry = { step: 'a.b', outputs: { v: s }, env: { [s || 'K']: s } };
      const text = entryYaml(entry);
      expect(parse(text), s).toEqual([entry]);
      expect(parse(text, { version: '1.1' }), s).toEqual([entry]);
    }
  });

  it('quotes a key YAML would misread', () => {
    expect(entryYaml({ step: 'a.b', env: { on: '1' } })).toBe("- step: a.b\n  env:\n    'on': '1'");
  });
});

describe('a unit under a calling job whose matrix only the run knows', () => {
  it('gets no draft, since no path selects the `[*]` leg', () => {
    const files = {
      [CI]: `on: push
jobs:
  web:
    strategy:
      matrix: \${{ fromJSON(vars.M) }}
    uses: ./.github/workflows/package.yml
`,
      '.github/workflows/package.yml': `on: workflow_call
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: detect
        uses: acme/detect@v1
      - run: echo built
        if: steps.detect.outputs.changed == 'true'
`,
    };
    const r = simulated(files, { event: 'push', branch: 'main' });
    const u = r.plan.unknowns.find((x) => x.id.endsWith('/steps.detect.outputs.changed'));
    expect(u).toBeDefined();
    expect(Object.values(r.derived.unitPaths).some((p) => p.includes('[*]'))).toBe(true);
    expect(draftFor(u!, contextOf(r))).toBeUndefined();
  });
});
