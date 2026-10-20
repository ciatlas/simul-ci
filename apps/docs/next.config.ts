import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Plain files in out/: the site has no server.
  output: 'export',
  reactStrictMode: true,
};

export default createMDX()(config);
