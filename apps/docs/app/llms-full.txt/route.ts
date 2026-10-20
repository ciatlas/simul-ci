import { llmsFull } from '../../lib/llms';
import { llmsPages } from '../../lib/llms-pages';
import { SITE_URL } from '../../lib/site';

export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return new Response(llmsFull(SITE_URL, await llmsPages()), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
