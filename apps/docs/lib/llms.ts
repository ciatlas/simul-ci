import type { Node, Root } from 'fumadocs-core/page-tree';

/**
 * llms.txt (llmstxt.org) and llms-full.txt, every link absolute: an index of the pages in sidebar order, a section
 * per sidebar separator, and every page's Markdown in one file.
 */

export interface LlmsPage {
  title: string;
  description?: string;
  url: string;
  markdown: string;
}

/** The pages of the sidebar in order, each with the separator above it. */
export function sidebarItems(tree: Root): { section: string; url: string; title: string }[] {
  const out: { section: string; url: string; title: string }[] = [];
  let section = 'Docs';
  const visit = (node: Node): void => {
    if (node.type === 'separator') section = text(node.name) || section;
    else if (node.type === 'page') out.push({ section, url: node.url, title: text(node.name) });
    else {
      if (node.index) visit(node.index);
      for (const child of node.children) visit(child);
    }
  };
  for (const node of tree.children) visit(node);
  return out;
}

export function llmsIndex(
  site: { url: string; name: string; description: string },
  tree: Root,
  pages: ReadonlyMap<string, LlmsPage>,
): string {
  const lines = [`# ${site.name}`, '', `> ${site.description}`];
  let section = '';
  for (const item of sidebarItems(tree)) {
    if (item.section !== section) {
      section = item.section;
      lines.push('', `## ${section}`, '');
    }
    const description = pages.get(item.url)?.description;
    const link = `- [${item.title}](${site.url}${item.url})`;
    lines.push(description ? `${link}: ${description}` : link);
  }
  lines.push('', '## Optional', '', `- [Every page in one file](${site.url}/llms-full.txt)`, '');
  return lines.join('\n');
}

export function llmsFull(siteUrl: string, pages: readonly LlmsPage[]): string {
  return `${pages.map((page) => llmsPage(siteUrl, page)).join('\n\n')}\n`;
}

function llmsPage(siteUrl: string, page: LlmsPage): string {
  const head = [`# ${page.title}`, '', `Source: ${siteUrl}${page.url}`];
  if (page.description) head.push('', `> ${page.description}`);
  return `${head.join('\n')}\n\n${absoluteLinks(siteUrl, withoutComments(page.markdown)).trim()}`;
}

/** MDX comments on lines of their own (release-please's version markers), and the blank line after each. */
const withoutComments = (markdown: string): string => markdown.replace(/^\{\/\*.*?\*\/\}\n(?:\n)?/gm, '');

/** Markdown links to a path of the site (`](/docs/x)`) made absolute. */
const absoluteLinks = (siteUrl: string, markdown: string): string =>
  markdown.replace(/\]\(\/(?!\/)/g, `](${siteUrl}/`);

const text = (name: unknown): string => (typeof name === 'string' ? name : '');
