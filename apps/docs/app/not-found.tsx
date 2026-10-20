import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { DefaultNotFound } from 'fumadocs-ui/layouts/home/not-found';
import type { Metadata } from 'next';
import { baseOptions } from '../lib/layout';

export const metadata: Metadata = { title: 'Not found' };

/** The site's own 404, with its navigation, rather than Next's bare page. */
export default function NotFound() {
  return (
    <HomeLayout {...baseOptions}>
      <DefaultNotFound />
    </HomeLayout>
  );
}
