import type { Root } from 'fumadocs-core/page-tree';
import { describe, expect, it } from 'vitest';
import { type LlmsPage, llmsFull, llmsIndex, sidebarItems } from '../lib/llms';

const SITE = { url: 'https://docs.test', name: 'simulci', description: 'What runs, and why.' };

const tree: Root = {
  name: 'simulci',
  children: [
    { type: 'page', name: 'Getting started', url: '/docs' },
    { type: 'separator', name: 'CLI' },
    {
      type: 'folder',
      name: 'cli',
      index: { type: 'page', name: 'Commands', url: '/docs/cli' },
      children: [{ type: 'page', name: 'simulci plan', url: '/docs/cli/plan' }],
    },
  ],
};

const page = (url: string, title: string, markdown: string, description?: string): LlmsPage => ({
  url,
  title,
  markdown,
  ...(description ? { description } : {}),
});

describe('llms.txt', () => {
  it('lists the pages in sidebar order, a section per separator', () => {
    expect(sidebarItems(tree).map((i) => `${i.section} ${i.url}`)).toEqual([
      'Docs /docs',
      'CLI /docs/cli',
      'CLI /docs/cli/plan',
    ]);
  });

  it('links every page by its absolute URL, with its description', () => {
    const pages = new Map([['/docs/cli/plan', page('/docs/cli/plan', 'simulci plan', '', 'The plan.')]]);
    const text = llmsIndex(SITE, tree, pages);
    expect(text).toContain(
      '# simulci\n\n> What runs, and why.\n\n## Docs\n\n- [Getting started](https://docs.test/docs)',
    );
    expect(text).toContain(
      '## CLI\n\n- [Commands](https://docs.test/docs/cli)\n- [simulci plan](https://docs.test/docs/cli/plan): The plan.',
    );
    expect(text).toContain('(https://docs.test/llms-full.txt)');
    expect(text).not.toMatch(/\]\(\//);
  });

  it('writes every page in full, its links to the site made absolute', () => {
    const text = llmsFull(SITE.url, [
      page(
        '/docs',
        'Getting started',
        'See [plan](/docs/cli/plan), [npm](https://npmjs.com) and [x](//cdn.test).\n',
      ),
    ]);
    expect(text).toBe(
      '# Getting started\n\nSource: https://docs.test/docs\n\nSee [plan](https://docs.test/docs/cli/plan), [npm](https://npmjs.com) and [x](//cdn.test).\n',
    );
  });
});
