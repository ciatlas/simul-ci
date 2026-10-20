import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '../../../lib/source';

// The search index as a static file; the dialog downloads it and searches in the browser.
export const dynamic = 'force-static';

export const { staticGET: GET } = createFromSource(source, { language: 'english' });
