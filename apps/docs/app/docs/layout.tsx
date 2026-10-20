import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '../../lib/layout';
import { source } from '../../lib/source';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions}>
      {children}
    </DocsLayout>
  );
}
