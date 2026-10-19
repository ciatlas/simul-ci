import { defineConfig, devices } from '@playwright/test';

/**
 * The browser pass: the specs under e2e/ drive the built app (`pnpm --filter @simulci/web build` first) as `vite
 * preview` serves it, workers and all, in headless Chromium. The port is the preview's default and must be free, so
 * a preview of another checkout is never the one tested.
 */

const PORT = 4173;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: CI,
  reporter: CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
