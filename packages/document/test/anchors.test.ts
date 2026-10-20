import { describe, expect, it } from 'vitest';
import { visit, isAlias } from 'yaml';
import { WorkflowDocument } from '@simulci/document';
import { corpus, fixture } from './corpus';

const open = (text: string) => WorkflowDocument.open(text, { path: 'x.yml', kind: 'workflow' });

describe('AnchorIndex', () => {
  const doc = open(fixture('anchors.yml'));
  const { anchors } = doc;

  it('lists every anchor with its token, its path and the aliases that name it', () => {
    expect(
      anchors.anchors.map((a) => [
        a.name,
        a.path.join('.'),
        a.line,
        doc.text.slice(a.from, a.to),
        a.aliases.length,
      ]),
    ).toEqual([
      ['runner', 'env.RUNNER', 5, '&runner', 2],
      ['defaults', 'defaults', 8, '&defaults', 1],
      ['job', 'jobs.build', 12, '&job', 2],
      ['checkout', 'jobs.build.steps.0', 16, '&checkout', 1],
      ['runner', 'jobs.redefined.runs-on', 29, '&runner', 1],
      ['later', 'jobs.redefined.env.LATER', 32, '&later', 0],
    ]);
  });

  it('points each alias at the closest definition above it', () => {
    const where = (path: string) => anchors.aliases.find((a) => a.path.join('.') === path)!;
    expect(where('jobs.build.runs-on').target?.line).toBe(5);
    expect(where('jobs.redefined.env.AFTER').target?.line).toBe(29);
    expect(where('jobs.test.steps.0').target?.path).toEqual(['jobs', 'build', 'steps', 0]);
    expect(doc.text.slice(where('jobs.again').from, where('jobs.again').to)).toBe('*job');
  });

  it('finds dangling aliases, telling a forward one from a missing anchor', () => {
    expect(anchors.dangling.map((a) => [a.name, a.path.join('.'), a.line, a.forward])).toEqual([
      ['later', 'env.EARLY', 6, true],
      ['nowhere', 'env.MISSING', 7, false],
    ]);
    // yaml reports neither: only toJS throws.
    expect(doc.errors).toEqual([]);
    expect(() => doc.tree.doc!.toJS()).toThrow(/Unresolved alias/);
  });

  it('lists the anchors aliases use, and finds a definition by its node or name', () => {
    expect(anchors.shared.map((a) => `${a.name}@${a.line}`)).toEqual([
      'runner@5',
      'defaults@8',
      'job@12',
      'checkout@16',
      'runner@29',
    ]);
    expect(anchors.definitions('runner').map((a) => a.line)).toEqual([5, 29]);
    const build = anchors.definitions('job')[0]!;
    expect(anchors.definedOn(build.node)).toBe(build);
    expect(anchors.definedOn(null)).toBeUndefined();
  });

  it('lists maps that use a merge key, but not a quoted one', () => {
    expect(anchors.merges.map((m) => [m.path.join('.'), m.line])).toEqual([['jobs.merged', 26]]);
  });

  it('indexes what yaml composed, over the corpus', () => {
    for (const { name, text } of corpus()) {
      const { tree, anchors: index } = open(text);
      let defined = 0;
      let used = 0;
      if (tree.doc)
        visit(tree.doc, {
          Node: (_, node) => {
            if (node.anchor) defined++;
            if (isAlias(node)) used++;
          },
        });
      expect([index.anchors.length, index.aliases.length], name).toEqual([defined, used]);
    }
  });
});

describe('reading through anchors', () => {
  const doc = open(fixture('anchors.yml'));

  it('reads an alias as the value it names, and says so', () => {
    expect(doc.get(['jobs', 'test', 'runs-on'])).toMatchObject({
      kind: 'alias',
      alias: 'runner',
      value: 'ubuntu-latest',
      source: '*runner',
      line: 20,
    });
    expect(doc.get(['env', 'MISSING'])).toMatchObject({ kind: 'alias', alias: 'nowhere' });
    expect(doc.get(['env', 'MISSING'])!.value).toBeUndefined();
  });

  it('reads through an aliased job to the anchored node, naming the alias', () => {
    expect(doc.get(['jobs', 'again', 'runs-on'])).toMatchObject({
      kind: 'alias',
      alias: 'job',
      value: 'ubuntu-latest',
    });
    expect(doc.get(['jobs', 'again', 'steps', 1, 'run'])).toMatchObject({
      kind: 'scalar',
      alias: 'job',
      value: 'make',
      line: 18,
    });
  });

  it('marks what an anchor with aliases holds: changing it changes them', () => {
    expect(doc.get(['env', 'RUNNER'])).toMatchObject({
      anchor: 'runner',
      sharedAnchor: { name: 'runner', uses: 2 },
    });
    expect(doc.get(['jobs', 'build', 'steps', 0, 'uses'])).toMatchObject({
      sharedAnchor: { name: 'checkout', uses: 1 },
    });
    // The innermost anchor names it: the step is anchored inside the anchored job.
    expect(doc.get(['jobs', 'build', 'steps', 1, 'run'])).toMatchObject({
      sharedAnchor: { name: 'job', uses: 2 },
    });
    expect(doc.get(['jobs', 'redefined', 'env', 'LATER'])).not.toHaveProperty('sharedAnchor');
    expect(doc.get(['jobs', 'test', 'steps', 1])).not.toHaveProperty('sharedAnchor');
  });

  it('marks a map on the path that uses a merge key', () => {
    expect(doc.get(['jobs', 'merged', 'name'])).toMatchObject({ merge: true });
    expect(doc.get(['jobs', 'merged'])).toMatchObject({ merge: true });
    expect(doc.get(['jobs', 'quoted'])).toMatchObject({ merge: false });
    expect(doc.get(['jobs', 'build'])).toMatchObject({ merge: false });
  });
});
