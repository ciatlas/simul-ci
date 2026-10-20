import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { REPO_URL } from './site';

/** What the landing and the docs share: the wordmark and the repository link. */
export const baseOptions: BaseLayoutProps = {
  nav: { title: <span className="font-semibold tracking-tight">simulci</span> },
  githubUrl: REPO_URL,
};
