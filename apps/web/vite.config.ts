import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const FONT = /\.(?:woff2?|ttf|otf|eot)$/;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // The engine and @ciatlas/core ship TypeScript source under the `source` export condition; core's `browser`
    // condition (one of the defaults) picks its entry without node:fs, node:path or git.
    conditions: ['source', ...defaultClientConditions],
  },
  // The engine runs in an ES module worker, so it can be a chunk of its own.
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: true,
    // A font stays a file, however small: the CSP's font-src 'self' (vercel.json) refuses a data: URI. Other assets
    // follow Vite's 4 kB rule.
    assetsInlineLimit: (file) => (FONT.test(file) ? false : undefined),
  },
});
