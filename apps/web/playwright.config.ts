import { defineConfig, devices } from '@playwright/test';

/**
 * The browser pass: the specs under e2e/ drive the built app (`pnpm --filter @simulci/web build` first) as `vite
 * preview` serves it, with vercel.json's headers and rewrites (vercel-headers.ts), workers and all, in headless
 * Chromium. The port is the preview's default and must be free, so a preview of another checkout is never the one
 * tested. With BASE_URL set (a deployment, as the deployment smoke workflow runs it) only the deployment smoke runs,
 * against that URL, and nothing is served locally.
 */

const PORT = 4173;
const CI = Boolean(process.env.CI);
const DEPLOYMENT = process.env.BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  ...(DEPLOYMENT ? { testMatch: 'deploy.spec.ts' } : {}),
  forbidOnly: CI,
  reporter: CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: DEPLOYMENT ?? `http://localhost:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    // Vercel adds its Toolbar, a script from vercel.live that the CSP refuses, to preview deployments unless asked not to.
    ...(DEPLOYMENT ? { extraHTTPHeaders: { 'x-vercel-skip-toolbar': '1' } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(DEPLOYMENT
    ? {}
    : {
        webServer: {
          command: `pnpm exec vite preview --port ${PORT} --strictPort`,
          url: `http://localhost:${PORT}`,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});
