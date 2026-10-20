/**
 * The site's own facts. `SITE_URL` makes every link in llms.txt and llms-full.txt absolute: on Vercel it is the
 * project's production domain (its own *.vercel.app URL until a domain is added); a build anywhere else (CI, local)
 * is never served, and its links go to a reserved `.example` name that cannot resolve to anyone's site.
 */

const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const SITE_URL = vercel ? `https://${vercel}` : 'https://simulci.example';

/** The web app. */
export const APP_URL = 'https://simulci.vercel.app';

export const REPO_URL = 'https://github.com/ciatlas/simulci';

export const DESCRIPTION =
  'Static simulator and test framework for GitHub Actions: which jobs and steps run for a scenario, and why.';
