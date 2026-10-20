import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SymbolLocator, sym, type WorkflowDecl } from '@ciatlas/core';
import {
  type LoadedProject,
  loadFiles,
  type Reference,
  type ReferenceTarget,
  referencesOf,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

/**
 * `referencesOf` for renames: every place a job's or a step's id is written, cut to the id, so writing a new id over
 * each span renames it. Checked on the routes lab, on flowpact's release workflow, and on the YAML shapes an
 * expression can take.
 */

const lab = join(import.meta.dirname, '../../../fixtures/routes-lab/repo');
const labFiles: Record<string, string> = {};
for (const name of readdirSync(join(lab, '.github/workflows')))
  labFiles[`.github/workflows/${name}`] = readFileSync(join(lab, '.github/workflows', name), 'utf8');
const labProject = loadFiles(labFiles);

const job = (workflow: string, id: string): ReferenceTarget => ({
  kind: 'job',
  workflow: `.github/workflows/${workflow}`,
  job: id,
});
const step = (workflow: string, jobId: string, id: string): ReferenceTarget => ({
  kind: 'step',
  workflow: `.github/workflows/${workflow}`,
  job: jobId,
  step: id,
});

/** `role line:column` of each reference, the shape most assertions read best in. */
const brief = (refs: Reference[]) => refs.map((r) => `${r.role} ${r.line}:${r.column}`);

function countRoles(refs: Reference[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of refs) counts[r.role] = (counts[r.role] ?? 0) + 1;
  return counts;
}

/**
 * Writes `to` over every reference, from the last, after checking each span holds the text it claims: what the main
 * thread does before it splices (`text.slice(from, to) === expected`).
 */
function rename(text: string, refs: Reference[], to: string): string {
  const starts = [0];
  for (const m of text.matchAll(/\n/g)) starts.push(m.index + 1);
  const offset = (line: number, column: number) => starts[line - 1]! + column - 1;
  let out = text;
  for (const r of refs.toReversed()) {
    const from = offset(r.line, r.column);
    const end = offset(r.endLine, r.endColumn);
    expect(text.slice(from, end)).toBe(r.text);
    out = out.slice(0, from) + to + out.slice(end);
  }
  return out;
}

/** The workflow's expression references in `contexts` whose first segment is `id`, in the job `inJob` if given. */
function readsNaming(wf: WorkflowDecl, contexts: string[], id: string, inJob?: string): number {
  let n = 0;
  for (const site of wf.sites) {
    if (inJob !== undefined && site.job !== inJob) continue;
    for (const seg of site.segments)
      for (const ref of seg.refs)
        if (contexts.includes(ref.context) && ref.path[0]?.toLowerCase() === id.toLowerCase()) n++;
  }
  return n;
}

const workflowOf = (project: LoadedProject, path: string) => project.index.project.workflows.get(path)!;

describe('referencesOf: the routes lab', () => {
  it("a job read by a workflow_call output: its key and the jobs.<id> read, not its output's name", () => {
    const refs = referencesOf(labProject, job('callee-skipped.yml', 'x'));
    expect(refs).toEqual([
      {
        file: '.github/workflows/callee-skipped.yml',
        line: 8,
        column: 25,
        endLine: 8,
        endColumn: 26,
        text: 'x',
        role: 'read',
      },
      {
        file: '.github/workflows/callee-skipped.yml',
        line: 10,
        column: 3,
        endLine: 10,
        endColumn: 4,
        text: 'x',
        role: 'key',
      },
    ]);
  });

  it('a one-letter job: reads inside ${{ }} only, never the same words in a script or toJSON(needs)', () => {
    const path = '.github/workflows/case-grandparent-outputs.yml';
    const refs = referencesOf(labProject, job('case-grandparent-outputs.yml', 'a'));
    expect(brief(refs)).toEqual([
      'key 6:3',
      'needs 14:12',
      'read 18:56',
      'read 21:15',
      'read 31:19',
      'read 37:52',
    ]);
    const out = rename(labFiles[path]!, refs, 'alpha');
    expect(out.match(/probe: needs\.a\.outputs\.v=/g)).toHaveLength(2);
    expect(out).toContain('NEEDS: ${{ toJSON(needs) }}');
    expect(out).toContain('${{ needs.alpha.outputs.v }}');
  });

  it("a job's whole outputs object and its result", () => {
    const refs = referencesOf(labProject, job('case-skipped-job-outputs.yml', 'a'));
    expect(countRoles(refs)).toEqual({ key: 1, needs: 1, read: 5 });
  });

  it('a job that calls a reusable workflow', () => {
    const refs = referencesOf(labProject, job('case-reusable-skipped-call.yml', 'call'));
    expect(brief(refs)).toEqual(['key 5:3', 'needs 9:12', 'read 14:56', 'needs 16:12', 'read 20:56']);
  });

  it("a step's id: its value and the steps.<id> reads of its job's outputs", () => {
    const refs = referencesOf(labProject, step('case-matrix-outputs.yml', 'a', 'set'));
    expect(brief(refs)).toEqual(['read 13:20', 'read 14:20', 'key 17:13']);
    expect(refs.map((r) => r.text)).toEqual(['set', 'set', 'set']);
  });

  it("a step's outputs, outcome and conclusion, its whole outputs object, in if: and in a literal block", () => {
    const refs = referencesOf(labProject, step('case-skipped-step-outputs.yml', 'a', 's'));
    expect(countRoles(refs)).toEqual({ key: 1, read: 8 });
    const out = rename(labFiles['.github/workflows/case-skipped-step-outputs.yml']!, refs, 'skip');
    expect(out).toContain('echo "probe: steps.s.outputs.x=${{ steps.skip.outputs.x }}"');
    expect(out).toContain('OUTPUTS: ${{ toJSON(steps.skip.outputs) }}');
  });

  it('nothing for a workflow, a job or a step that does not exist', () => {
    expect(referencesOf(labProject, job('nope.yml', 'a'))).toEqual([]);
    expect(referencesOf(labProject, job('case-skipped-job-outputs.yml', 'zz'))).toEqual([]);
    expect(referencesOf(labProject, step('case-skipped-step-outputs.yml', 'a', 'zz'))).toEqual([]);
  });

  /** Every id renamed in turn: afterwards nothing names the old id, and the new one has the same references. */
  const workflows = [...labProject.index.project.workflows.values()];
  const jobs = workflows.flatMap((wf) => Object.keys(wf.jobs).map((id) => ({ wf, id })));
  const steps = workflows.flatMap((wf) =>
    Object.values(wf.jobs).flatMap((j) =>
      j.steps.flatMap((s) => (s.id ? [{ wf, job: j.id, id: s.id }] : [])),
    ),
  );

  it.each(jobs.map(({ wf, id }) => [`${wf.path.split('/').pop()}#${id}`, wf, id] as const))(
    'renaming the job %s leaves no reference to its old id',
    (_, wf, id) => {
      const before = referencesOf(labProject, { kind: 'job', workflow: wf.path, job: id });
      expect(before[0]).toBeDefined();
      const to = `${id}_renamed`;
      const project = loadFiles({ ...labFiles, [wf.path]: rename(labFiles[wf.path]!, before, to) });
      const after = workflowOf(project, wf.path);
      expect(after.parseErrors).toEqual([]);
      expect(Object.keys(after.jobs)).toContain(to);
      expect(Object.values(after.jobs).flatMap((j) => j.needs.filter((n) => !after.jobs[n.id]))).toEqual([]);
      expect(readsNaming(after, ['needs', 'jobs'], id)).toBe(0);
      const renamed = referencesOf(project, { kind: 'job', workflow: wf.path, job: to });
      expect(renamed.map((r) => `${r.role} ${r.line}`)).toEqual(before.map((r) => `${r.role} ${r.line}`));
    },
  );

  it.each(steps.map(({ wf, job: j, id }) => [`${wf.path.split('/').pop()}#${j}.${id}`, wf, j, id] as const))(
    'renaming the step %s leaves no reference to its old id in its job',
    (_, wf, j, id) => {
      const before = referencesOf(labProject, { kind: 'step', workflow: wf.path, job: j, step: id });
      expect(before.filter((r) => r.role === 'key')).toHaveLength(1);
      const to = `${id}_renamed`;
      const project = loadFiles({ ...labFiles, [wf.path]: rename(labFiles[wf.path]!, before, to) });
      const after = workflowOf(project, wf.path);
      expect(after.parseErrors).toEqual([]);
      expect(readsNaming(after, ['steps'], id, j)).toBe(0);
      const renamed = referencesOf(project, { kind: 'step', workflow: wf.path, job: j, step: to });
      expect(renamed.map((r) => `${r.role} ${r.line}`)).toEqual(before.map((r) => `${r.role} ${r.line}`));
    },
  );
});

describe("referencesOf: flowpact's release workflow", () => {
  const path = '.github/workflows/release.yml';
  const text = readFileSync(join(import.meta.dirname, 'fixtures/flowpact-release.yml'), 'utf8');
  const project = loadFiles({ [path]: text });
  const wf = workflowOf(project, path);

  it("core finds 56 occurrences of resolve and its outputs, 3 of them the outputs' names", () => {
    const locator = new SymbolLocator(project.index);
    const outputs = Object.keys(wf.jobs.resolve!.outputs);
    expect(outputs).toEqual(['tag', 'version', 'prerelease']);
    const occurrences = [
      sym.job(path, 'resolve'),
      ...outputs.map((o) => sym.jobOutput(path, 'resolve', o)),
    ].flatMap((s) => locator.occurrences(s));
    expect(occurrences).toHaveLength(56);
    expect(
      occurrences.filter((o) => o.role === 'declaration' && o.symbol !== sym.job(path, 'resolve')),
    ).toHaveLength(3);
  });

  it('the resolve job: 53 references, each cut to the id, none of them an output name', () => {
    const refs = referencesOf(project, { kind: 'job', workflow: path, job: 'resolve' });
    expect(refs).toHaveLength(53);
    expect(countRoles(refs)).toEqual({ key: 1, needs: 10, read: 42 });
    expect(new Set(refs.map((r) => r.text))).toEqual(new Set(['resolve']));
    expect(refs.every((r) => r.endLine === r.line && r.endColumn - r.column === 'resolve'.length)).toBe(true);
    const outputLines = new Set(Object.values(wf.jobs.resolve!.outputs).map((o) => o.loc.line));
    expect(refs.filter((r) => outputLines.has(r.line))).toEqual([]);
    // Every `needs.resolve` written in the file is in an expression; one line holds two.
    expect(text.match(/needs\.resolve\b/g)).toHaveLength(42);
  });

  it('renaming resolve to tag-resolve changes 52 lines and leaves nothing dangling', () => {
    const refs = referencesOf(project, { kind: 'job', workflow: path, job: 'resolve' });
    const out = rename(text, refs, 'tag-resolve');
    const before = text.split('\n');
    const changed = out.split('\n').filter((line, i) => line !== before[i]);
    expect(changed).toHaveLength(52);
    expect(out).not.toMatch(/needs\.resolve\b|needs: resolve\b|\[resolve,/);
    const after = workflowOf(loadFiles({ [path]: out }), path);
    expect(after.parseErrors).toEqual([]);
    expect(Object.keys(after.jobs)).toContain('tag-resolve');
    expect(Object.values(after.jobs).flatMap((j) => j.needs.filter((n) => !after.jobs[n.id]))).toEqual([]);
    expect(readsNaming(after, ['needs'], 'tag-resolve')).toBe(42);
  });

  it("steps: release-please's rp and resolve's tag, which other jobs' steps do not share", () => {
    const rp = referencesOf(project, { kind: 'step', workflow: path, job: 'release-please', step: 'rp' });
    expect(countRoles(rp)).toEqual({ key: 1, read: 7 });
    const tag = referencesOf(project, { kind: 'step', workflow: path, job: 'resolve', step: 'tag' });
    expect(countRoles(tag)).toEqual({ key: 1, read: 4 });
    expect(new Set([...rp, ...tag].map((r) => r.text))).toEqual(new Set(['rp', 'tag']));
  });
});

describe('referencesOf: how YAML and expressions write an id', () => {
  const path = '.github/workflows/shapes.yml';
  const lines = [
    'on:',
    '  workflow_call:',
    '    outputs:',
    '      out:',
    '        value: ${{ jobs.build.outputs.v }}',
    '      res:',
    "        value: ${{ jobs['build'].result }}",
    'jobs:',
    '  "build":',
    '    runs-on: ubuntu-latest',
    '    outputs:',
    '      v: ${{ steps.meta.outputs.v }}',
    '    steps:',
    "      - id: 'meta'",
    '        run: echo "v=1" >> "$GITHUB_OUTPUT"',
    "      - if: steps.META.outcome == 'success' && steps . meta . outputs.v",
    '        run: echo ${{ toJSON(steps.meta.outputs) }} steps.meta.outputs.v',
    '  build-x:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - id: meta',
    '        run: echo',
    '      - run: echo ${{ steps.meta.outcome }}',
    '  deploy:',
    "    needs: ['build', build-x]",
    '    runs-on: ubuntu-latest',
    '    env:',
    '      A: "tab\\there ${{ needs.build.outputs.v }}"',
    "      B: 'it''s ${{ needs[''build''].outputs.v }} ${{ needs.build-x.result }}'",
    '      C: >-',
    '        folded',
    '        ${{ needs.Build.outputs.v }}',
    '      D: |',
    '        literal ${{ needs.build.result }} needs.build.result',
    "      E: ${{ toJSON(needs) }} ${{ needs[matrix.j].result }} ${{ 'needs.build' }}",
    '      F: "${{ needs.\\x62uild.result }}"',
    '      G: ${{ toJSON(needs.build.outputs) }} ${{ needs.build.outputs.undeclared }}',
    '      H: >',
    '        ${{ needs.build',
    '          .result }}',
    '    steps:',
    '      - run: echo',
    '  last:',
    '    needs:',
    '      - deploy',
    '      - "build"',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ];
  const text = lines.join('\n');
  const project = loadFiles({ [path]: text });
  const build: ReferenceTarget = { kind: 'job', workflow: path, job: 'build' };

  it('a job: quoted key, needs as a scalar, a flow list and a block list, reads in every scalar style', () => {
    const refs = referencesOf(project, build);
    expect(brief(refs)).toEqual([
      'read 5:25', // jobs.build in a workflow_call output
      'read 7:26', // jobs['build']
      'key 9:4', // "build":
      'needs 19:12', // needs: build
      'needs 26:14', // needs: ['build', build-x]
      'read 29:31', // double-quoted, with an escape before it
      'read 30:29', // single-quoted: needs[''build'']
      'read 33:19', // folded (>-), written Build
      'read 35:27', // literal (|), not the copy after the expression
      'read 38:27', // toJSON(needs.build.outputs)
      'read 38:55', // an output nobody declares
      'read 40:19', // a reference broken across lines of a folded scalar
      'needs 47:10', // - "build"
    ]);
    expect(refs.find((r) => r.line === 33)?.text).toBe('Build');
    expect(refs.filter((r) => r.text.toLowerCase() !== 'build')).toEqual([]);
  });

  it('leaves alone what does not name the job: another id, computed keys, strings and escapes', () => {
    const out = rename(text, referencesOf(project, build), 'compile').split('\n');
    expect(out[17]).toBe('  build-x:');
    expect(out[25]).toBe("    needs: ['compile', build-x]");
    expect(out[29]).toBe("      B: 'it''s ${{ needs[''compile''].outputs.v }} ${{ needs.build-x.result }}'");
    expect(out[34]).toBe('        literal ${{ needs.compile.result }} needs.build.result');
    expect(out[35]).toBe(lines[35]);
    // An escape spells the id here: a splice cannot keep it, so the read is not listed (and keeps the old id).
    expect(out[36]).toBe(lines[36]);
    expect(out.slice(39, 41)).toEqual(['        ${{ needs.compile', '          .result }}']);
    const after = workflowOf(loadFiles({ [path]: out.join('\n') }), path);
    expect(after.parseErrors).toEqual([]);
    expect(after.jobs.last!.needs.map((n) => n.id)).toEqual(['deploy', 'compile']);
  });

  it('a step: a quoted id:, reads with spaces and in another case, and not the same id in another job', () => {
    const refs = referencesOf(project, { kind: 'step', workflow: path, job: 'build', step: 'meta' });
    expect(brief(refs)).toEqual(['read 12:20', 'key 14:14', 'read 16:19', 'read 16:56', 'read 17:36']);
    expect(refs.map((r) => r.text)).toEqual(['meta', 'meta', 'META', 'meta', 'meta']);
    const other = referencesOf(project, { kind: 'step', workflow: path, job: 'build-x', step: 'meta' });
    expect(brief(other)).toEqual(['key 22:13', 'read 24:29']);
  });

  it('the same lines and columns in a CRLF file', () => {
    const crlf = loadFiles({ [path]: lines.join('\r\n') });
    expect(referencesOf(crlf, build)).toEqual(referencesOf(project, build));
  });
});
