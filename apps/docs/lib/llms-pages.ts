import { sidebarItems, type LlmsPage } from './llms';
import { source } from './source';

/** The docs pages in sidebar order, with the Markdown they render from. */
export async function llmsPages(): Promise<LlmsPage[]> {
  const pages = new Map(source.getPages().map((p) => [p.url, p]));
  const ordered = sidebarItems(source.getPageTree()).flatMap((item) => pages.get(item.url) ?? []);
  return Promise.all(
    ordered.map(async (page): Promise<LlmsPage> => {
      const out: LlmsPage = {
        title: page.data.title,
        url: page.url,
        markdown: await page.data.getText('processed'),
      };
      if (page.data.description) out.description = page.data.description;
      return out;
    }),
  );
}
