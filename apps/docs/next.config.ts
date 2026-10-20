import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Plain files in out/: the site has no server.
  output: 'export',
  reactStrictMode: true,
  // `pnpm typecheck` checks the types, the tests' too; Vercel's filtered install has none of the CLI's dependencies
  // the tests import, so the build does not check them again.
  typescript: { ignoreBuildErrors: true },
};

export default createMDX()(config);
