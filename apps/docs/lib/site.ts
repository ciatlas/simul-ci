/**
 * The site's own facts. `SITE_URL` makes every link in llms.txt and llms-full.txt absolute: on Vercel it is the
 * project's production domain, elsewhere a placeholder until the domain is chosen.
 */

const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const SITE_URL = vercel ? `https://${vercel}` : 'https://simulci.example';

export const REPO_URL = 'https://github.com/ciatlas/simulci';

export const DESCRIPTION =
  'Static simulator and test framework for GitHub Actions: which jobs and steps run for a scenario, and why.';
