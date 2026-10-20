/**
 * The document model names a job or a step in a file by the unit path the engine selects it by (packages/document
 * `unitPathAt`, packages/engine `plan/select.ts`): the canvas, the URL's `sel` and the edit runtime convert between
 * the two, so they must agree on every job and step, a step without an id included (`#n`, from 1). Legs share their
 * job's text, so the engine's leg selector is not the document's to say. The document zone may not import the
 * engine, so the parity lives here, where both are the web app's.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadFiles, simulate } from '@simulci/engine';
import { unitPaths } from '@simulci/engine/plan';
import { unitPathAt, WorkflowDocument, yamlPathOf } from '@simulci/document';
import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/input/samples';

const EXTRA = {
  '.github/workflows/steps.yml': `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [a, b]
    steps:
      - uses: actions/checkout@v4
      - id: test
        run: npm test
      - name: Upload
        run: ./up
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps: [{ run: one }, { id: two, run: two }]
`,
};

const ROOT = join(import.meta.dirname, '../../..');

/** A checkout's workflows and actions by repository path, as the folder walk reads them. */
function checkout(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ya?ml$/.test(entry.name)) files[relative(dir, path)] = readFileSync(path, 'utf8');
    }
  };
  for (const sub of ['.github/workflows', '.github/actions'])
    if (existsSync(join(dir, sub))) walk(join(dir, sub));
  return files;
}

/** The samples, a file of every step shape, the routes lab and simulci's own workflows (the corpus of § 2.9). */
const CORPUS = [
  ...SAMPLES.map((s) => [s.name, s.files] as const),
  ['steps', EXTRA] as const,
  ['routes lab', checkout(join(ROOT, 'fixtures/routes-lab/repo'))] as const,
  ['simulci', checkout(ROOT)] as const,
];

describe('unit paths, in the document and in the engine', () => {
  for (const [name, files] of CORPUS)
    it(`agree on every job and step of the ${name} files`, () => {
      const loaded = loadFiles(files);
      const plan = simulate({
        project: loaded,
        scenario: { event: 'push', branch: 'main' },
        detail: 'steps',
        // The jobs of a workflow push does not trigger are planned too, so every job is compared.
        planUntriggered: Object.keys(files).filter((p) => p.startsWith('.github/workflows/')),
      });
      let compared = 0;
      for (const wf of plan.workflows.filter((w) => w.depth === 0)) {
        const doc = WorkflowDocument.open((files as Record<string, string>)[wf.path]!, {
          path: wf.path,
          kind: 'workflow',
        });
        const engine = unitPaths(wf);
        for (const job of wf.jobs) {
          expect(unitPathAt(doc, ['jobs', job.jobId])).toBe(engine.get(job.id));
          expect(yamlPathOf(doc, engine.get(job.id)!)).toEqual(['jobs', job.jobId]);
          for (const step of job.legs[0]?.steps ?? []) {
            // The engine spells a matrix leg's step under its leg; the document, under the job its text is in.
            const want = engine.get(step.id)!.replace(/\[[^\]]*\](?=\.)/, '');
            expect(unitPathAt(doc, ['jobs', job.jobId, 'steps', step.index])).toBe(want);
            expect(yamlPathOf(doc, engine.get(step.id)!)).toEqual(['jobs', job.jobId, 'steps', step.index]);
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(0);
    });
});
