import './global.css';
import type { Metadata } from 'next';
import { Provider } from '../components/provider';
import { DESCRIPTION, SITE_URL } from '../lib/site';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'simulci', template: '%s · simulci' },
  description: DESCRIPTION,
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
