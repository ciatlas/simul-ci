import { llmsIndex } from '../../lib/llms';
import { DESCRIPTION, SITE_URL } from '../../lib/site';
import { llmsPages } from '../../lib/llms-pages';
import { source } from '../../lib/source';

export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const pages = new Map((await llmsPages()).map((p) => [p.url, p]));
  const site = { url: SITE_URL, name: 'simulci', description: DESCRIPTION };
  return new Response(llmsIndex(site, source.getPageTree(), pages), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
