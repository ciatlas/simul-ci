import { describe, expect, it } from 'vitest';
import { isCollection, type ParsedNode } from 'yaml';
import { WorkflowDocument, unitPathAt, yamlPathOf, type YamlPath } from '@simulci/document';
import { itemSpan } from '../src/spans';
import { entriesOf, isFlow, locate, type Collection } from '../src/tree';
import { corpus, crlf, fixture, fixtures } from './corpus';

const open = (text: string) => WorkflowDocument.open(text, { path: 'x.yml', kind: 'workflow' });

/** Every item path of a document, parents before children (aliases not entered). */
function itemPaths(doc: WorkflowDocument): YamlPath[] {
  const out: YamlPath[] = [];
  const walk = (node: ParsedNode | null, path: YamlPath) => {
    for (const entry of entriesOf(node)) {
      const child = [...path, entry.segment];
      out.push(child);
      walk(entry.node, child);
    }
  };
  walk(doc.tree.doc?.contents ?? null, []);
  return out;
}

/** Every collection of a document with its path. */
function collections(doc: WorkflowDocument): { path: YamlPath; node: Collection }[] {
  return [[], ...itemPaths(doc)].flatMap((path) => {
    const node = locate(doc.tree, path)?.node;
    return isCollection(node) ? [{ path, node: node }] : [];
  });
}

/** A listing of what the cursor selects at the start of each line's content and at its end. */
function cursorListing(doc: WorkflowDocument): string {
  const { lines } = doc.tree;
  const rows: string[] = [];
  for (let line = 0; line < lines.count; line++) {
    const { indent } = lines.kind(line);
    const start = doc.pathAt(lines.start(line) + indent).join('.');
    const end = doc.pathAt(lines.breakAt(line)).join('.');
    rows.push(`${String(line + 1).padStart(3)} ${start || '·'}${end === start ? '' : `  →  ${end || '·'}`}`);
  }
  return `${rows.join('\n')}\n`;
}

/** Each item's span, as text. */
function spanListing(doc: WorkflowDocument): string {
  return itemPaths(doc)
    .map((path) => {
      const span = doc.spanOf(path)!;
      return `── ${path.join('.')} (line ${doc.lineOf(path)})\n${doc.text.slice(span.from, span.to)}`;
    })
    .join('\n');
}

describe('pathAt', () => {
  it.each(['comments.yml', 'shapes.yml', 'anchors.yml', 'indent4.yml', 'flush.yml'])(
    'matches the golden over %s',
    async (name) => {
      await expect(cursorListing(open(fixture(name)))).toMatchFileSnapshot(`golden/path-at/${name}.txt`);
    },
  );

  it('answers a path whose item holds the offset, at every offset of the fixtures and every 7th of the rest', () => {
    for (const { name, text, owned } of corpus()) {
      const doc = open(text);
      if (!doc.status.editable) continue;
      const wrong: string[] = [];
      for (let at = 0; at <= text.length; at += owned ? 1 : 7) {
        const path = doc.pathAt(at);
        const span = path.length === 0 ? { from: 0, to: text.length } : doc.spanOf(path);
        if (!span || at < span.from || at > span.to) wrong.push(`@${at} ${path.join('.')}`);
      }
      expect(wrong, name).toEqual([]);
    }
  });

  it('selects inside flow collections by characters, ends included', () => {
    const doc = open('on:\n  push:\n    branches: [main, dev] # c\n');
    const text = doc.text;
    expect(doc.pathAt(text.indexOf('main'))).toEqual(['on', 'push', 'branches', 0]);
    expect(doc.pathAt(text.indexOf('dev') + 3)).toEqual(['on', 'push', 'branches', 1]);
    expect(doc.pathAt(text.indexOf('['))).toEqual(['on', 'push', 'branches']);
    expect(doc.pathAt(text.indexOf('# c'))).toEqual(['on', 'push', 'branches']);
  });

  it('gives the root for comments that no item owns', () => {
    const doc = open(fixture('comments.yml'));
    expect(doc.pathAt(0)).toEqual([]);
    expect(doc.pathAt(doc.text.indexOf('# Dangling at column 0'))).toEqual([]);
  });
});

describe('spanOf', () => {
  it.each(['comments.yml', 'shapes.yml', 'indent4.yml'])('matches the golden over %s', async (name) => {
    await expect(spanListing(open(fixture(name)))).toMatchFileSnapshot(`golden/spans/${name}.txt`);
  });

  it('gives a block collection’s items disjoint whole-line spans, in order, that cover its content lines', () => {
    for (const { name, text } of corpus()) {
      const doc = open(text);
      if (!doc.status.editable) continue;
      for (const { path, node } of collections(doc)) {
        if (isFlow(node) || node.items.length === 0) continue;
        const spans = node.items.map((_, i) => itemSpan(doc.tree, node, i));
        checkSpans(doc, `${name} ${path.join('.')}`, spans);
      }
    }
  });

  it('keeps leading comments at the item’s column and deeper trailing ones with the item', () => {
    const doc = open(fixture('comments.yml'));
    const slice = (path: YamlPath) => doc.text.slice(doc.spanOf(path)!.from, doc.spanOf(path)!.to);
    expect(slice(['jobs', 'build'])).toMatch(
      /^ {2}# Leading comment of build[\s\S]*# Trailing comment of build, at its keys' column\.\n$/,
    );
    expect(slice(['jobs', 'build', 'steps', 0])).toMatch(
      /^ {6}# Leading comment of the first step\.\n[\s\S]*deeper than its dash\.\n$/,
    );
    expect(slice(['jobs', 'test'])).not.toContain('Dangling');
    // A block scalar's own lines hold `#`s that are not comments.
    expect(slice(['jobs', 'build', 'steps', 2])).toContain('# not a comment: inside the block scalar\n');
  });

  it('ends a keep-chomped block scalar with its blank lines, and a clipped one with its last line', () => {
    const doc = open(fixture('shapes.yml'));
    const slice = (path: YamlPath) => doc.text.slice(doc.spanOf(path)!.from, doc.spanOf(path)!.to);
    expect(slice(['jobs', 'blocks', 'steps', 0])).toBe('      - run: |+\n          keep\n\n');
    expect(slice(['jobs', 'blocks', 'steps', 1])).toBe(
      '      - run: |\n          \ta tab inside the block\n          last\n',
    );
  });

  it('ends a null value on its key’s line', () => {
    const doc = open('on:\n  push:\n  pull_request: # c\n\njobs: {}\n');
    expect(doc.text.slice(doc.spanOf(['on', 'push'])!.from, doc.spanOf(['on', 'push'])!.to)).toBe(
      '  push:\n',
    );
    expect(
      doc.text.slice(doc.spanOf(['on', 'pull_request'])!.from, doc.spanOf(['on', 'pull_request'])!.to),
    ).toBe('  pull_request: # c\n');
  });

  it('starts an inline item at its key', () => {
    const doc = open(fixture('shapes.yml'));
    const span = doc.spanOf(['jobs', 'expanded', 'steps', 1, 'name'])!;
    expect(doc.text.slice(span.from, span.to)).toBe('name: Compact\n');
    expect(doc.lineOf(['jobs', 'expanded', 'steps', 0])).toBe(14);
    expect(doc.lineOf(['jobs', 'expanded', 'steps', 0, 'name'])).toBe(15);
  });

  it('is undefined for a missing path or one through an alias; the whole text for the root', () => {
    const doc = open(fixture('anchors.yml'));
    expect(doc.spanOf(['jobs', 'nope'])).toBeUndefined();
    expect(doc.spanOf(['jobs', 'again', 'runs-on'])).toBeUndefined();
    expect(doc.lineOf(['jobs', 'again', 'runs-on'])).toBeUndefined();
    expect(doc.spanOf([])).toEqual({ from: 0, to: doc.text.length });
    expect(doc.lineOf([])).toBe(1);
  });
});

function checkSpans(doc: WorkflowDocument, where: string, spans: ReturnType<typeof itemSpan>[]): void {
  const { lines } = doc.tree;
  for (const [i, span] of spans.entries()) {
    expect(
      span.inline || lines.start(lines.lineAt(span.from)) === span.from,
      `${where}[${i}] starts a line`,
    ).toBe(true);
    expect(
      span.to === doc.text.length || lines.start(lines.lineAt(span.to)) === span.to,
      `${where}[${i}] ends a line`,
    ).toBe(true);
    if (i > 0) expect(spans[i - 1]!.to <= span.from, `${where}[${i}] after [${i - 1}]`).toBe(true);
  }
  // Every content line from the first item to the end of the last belongs to an item.
  const first = lines.lineAt(spans[0]!.own);
  const last = lines.lineAt(Math.max(spans.at(-1)!.to - 1, spans.at(-1)!.own));
  for (let line = first; line <= last; line++) {
    if (lines.kind(line).kind !== 'content') continue;
    const at = lines.start(line);
    const owned = spans.some((s) => (s.inline ? lines.lineAt(s.own) <= line : s.from <= at) && at < s.to);
    expect(owned, `${where}: line ${line + 1} owned`).toBe(true);
  }
}

describe('get', () => {
  it('describes a scalar, a map and a sequence by their own characters', () => {
    const doc = open(fixture('comments.yml'));
    expect(doc.get(['name'])).toEqual({
      kind: 'scalar',
      value: 'comments',
      source: 'comments',
      span: { from: 59, to: 67 },
      line: 2,
      flow: false,
      merge: false,
    });
    const build = doc.get(['jobs', 'build'])!;
    expect(build.kind).toBe('map');
    expect(build.source.startsWith('runs-on: ubuntu-latest\n')).toBe(true);
    // The map ends with its content, not where yaml's range ends (inside the next job).
    expect(build.source.endsWith('# not a comment: inside the block scalar')).toBe(true);
    expect(doc.get(['on', 'push', 'branches'])).toMatchObject({
      kind: 'seq',
      source: '[main]',
      flow: true,
      value: ['main'],
    });
    expect(doc.get(['on', 'push', 'branches', 0])).toMatchObject({ kind: 'scalar', flow: true });
    expect(doc.get(['on', 'pull_request'])).toMatchObject({ kind: 'null', value: null, source: '' });
    expect(doc.get(['jobs', 'nope'])).toBeUndefined();
    expect(doc.get(['jobs', 0])).toBeUndefined();
  });

  it('tells literal and folded block scalars apart', () => {
    const doc = open(fixture('shapes.yml'));
    expect(doc.get(['jobs', 'blocks', 'if'])).toMatchObject({
      block: 'folded',
      value: "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    });
    expect(doc.get(['jobs', 'blocks', 'steps', 0, 'run'])).toMatchObject({
      block: 'literal',
      value: 'keep\n\n',
    });
  });

  it('reads the same values as yaml’s toJS, over the corpus', () => {
    for (const { name, text } of corpus()) {
      const doc = open(text);
      if (!doc.status.editable || doc.anchors.aliases.length > 0) continue;
      const js = doc.tree.doc!.toJS();
      for (const path of itemPaths(doc)) {
        const want = path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)[k], js);
        expect(doc.get(path)?.value, `${name} ${path.join('.')}`).toEqual(want);
      }
    }
  });
});

describe('jobs', () => {
  it('lists jobs and steps with what identifies a step', () => {
    const doc = open(fixture('shapes.yml'));
    expect(doc.jobs().map((j) => [j.id, j.line, j.steps.length])).toEqual([
      ['flow-steps', 6, 2],
      ['expanded', 11, 2],
      ['blocks', 19, 3],
      ['empty', 33, 2],
    ]);
    expect(doc.jobs()[0]!.steps).toEqual([
      { index: 0, uses: 'actions/checkout@v4', line: 9 },
      { index: 1, runHead: 'echo', line: 10 },
    ]);
    expect(doc.jobs()[1]!.steps[0]).toEqual({
      index: 0,
      name: 'Expanded',
      runHead: 'echo expanded',
      line: 14,
    });
    expect(doc.jobs()[2]!.steps[1]).toMatchObject({ runHead: '\ta tab inside the block' });
    expect(doc.jobs()[3]!.steps[0]).toEqual({ index: 0, line: 36 });
  });

  it('agrees with toJS over the corpus', () => {
    for (const { name, text } of corpus()) {
      const doc = open(text);
      if (!doc.status.editable || doc.anchors.aliases.length > 0) continue;
      const jobs =
        (doc.tree.doc!.toJS() as { jobs?: Record<string, { steps?: Record<string, unknown>[] }> }).jobs ?? {};
      expect(
        doc.jobs().map((j) => j.id),
        name,
      ).toEqual(Object.keys(jobs));
      for (const job of doc.jobs()) {
        const steps = jobs[job.id]?.steps ?? [];
        expect(
          job.steps.map((s) => s.id),
          name,
        ).toEqual(steps.map((s) => s?.id ?? undefined));
        expect(
          job.steps.map((s) => s.uses),
          name,
        ).toEqual(steps.map((s) => s?.uses ?? undefined));
        expect(
          job.steps.map((s) => s.runHead),
          name,
        ).toEqual(steps.map((s) => (s?.run as string | undefined)?.split('\n')[0]));
      }
    }
  });

  it('reads aliased jobs and steps through their anchors', () => {
    const doc = open(fixture('anchors.yml'));
    const byId = Object.fromEntries(doc.jobs().map((j) => [j.id, j]));
    expect(byId.test!.steps[0]).toEqual({ index: 0, uses: 'actions/checkout@v4', line: 22 });
    expect(byId.again!.steps.map((s) => s.uses ?? s.runHead)).toEqual(['actions/checkout@v4', 'make']);
  });
});

describe('unit paths', () => {
  it('names jobs and steps as the engine does: by id, else by 1-based position', () => {
    const doc = open(fixture('comments.yml').replace('- name: First', '- id: first\n        name: First'));
    expect(unitPathAt(doc, ['jobs', 'build'])).toBe('build');
    expect(unitPathAt(doc, ['jobs', 'build', 'runs-on'])).toBe('build');
    expect(unitPathAt(doc, ['jobs', 'build', 'steps', 0, 'run'])).toBe('build.first');
    expect(unitPathAt(doc, ['jobs', 'build', 'steps', 1])).toBe('build.#2');
    expect(unitPathAt(doc, ['jobs', 'build', 'steps', 9])).toBe('build');
    expect(unitPathAt(doc, ['jobs', 'nope'])).toBeUndefined();
    expect(unitPathAt(doc, ['on', 'push'])).toBeUndefined();
  });

  it('finds the path of a unit path, legs, qualifiers and nested steps naming their nearest node here', () => {
    const doc = open(fixture('comments.yml').replace('- name: First', '- id: first\n        name: First'));
    expect(yamlPathOf(doc, 'build')).toEqual(['jobs', 'build']);
    expect(yamlPathOf(doc, 'Build')).toEqual(['jobs', 'build']);
    expect(yamlPathOf(doc, 'build.first')).toEqual(['jobs', 'build', 'steps', 0]);
    expect(yamlPathOf(doc, 'build.#3')).toEqual(['jobs', 'build', 'steps', 2]);
    expect(yamlPathOf(doc, 'build[node=22].#2')).toEqual(['jobs', 'build', 'steps', 1]);
    expect(yamlPathOf(doc, 'ci.yml:build.#2')).toEqual(['jobs', 'build', 'steps', 1]);
    expect(yamlPathOf(doc, 'build.first/inner')).toEqual(['jobs', 'build', 'steps', 0]);
    expect(yamlPathOf(doc, 'build/callee.step')).toEqual(['jobs', 'build']);
    expect(yamlPathOf(doc, 'build.#4')).toBeUndefined();
    expect(yamlPathOf(doc, 'build.#0')).toBeUndefined();
    expect(yamlPathOf(doc, 'build.nope')).toBeUndefined();
    expect(yamlPathOf(doc, 'nope')).toBeUndefined();
    expect(yamlPathOf(doc, '')).toBeUndefined();
  });

  it('round-trips every job and step of the corpus', () => {
    for (const { name, text: lf } of fixtures())
      for (const text of [lf, crlf(lf)]) {
        const doc = open(text);
        for (const job of doc.jobs()) {
          expect(yamlPathOf(doc, unitPathAt(doc, ['jobs', job.id])!), name).toEqual(['jobs', job.id]);
          for (const step of job.steps) {
            const path = ['jobs', job.id, 'steps', step.index];
            expect(yamlPathOf(doc, unitPathAt(doc, path)!), `${name} ${path.join('.')}`).toEqual(path);
          }
        }
      }
  });
});

describe('offsetOf', () => {
  it('reads core’s 1-based Loc', () => {
    const doc = open('on: push\r\njobs:\r\n  a: 1\r\n');
    expect(doc.offsetOf(3, 3)).toBe(doc.text.indexOf('a: 1'));
    expect(doc.offsetOf(1, 1)).toBe(0);
  });
});
