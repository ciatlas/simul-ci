/**
 * The browser bundle's contract (scripts/check-web-bundle.mjs): its rules on small inputs, then on what the web app's
 * own Vite config builds, so a rule that cannot match Vite's output fails here instead of passing quietly in CI. The
 * built token sheet is checked too: like the fonts, its first paint is what the browser gets before any script runs,
 * and applyTheme is what takes over once one does.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyTheme } from '../../apps/web/src/app/theme';
import { chunkProblems, stylesheetProblems } from '../web-bundle-rules.mjs';

const root = join(import.meta.dirname, '../..');
const web = join(root, 'apps/web');

/** What the app's chunks list today, as their source maps spell it. */
const PAGE = [
  '../../src/main.tsx',
  '../../../../packages/engine/src/plan/index.ts',
  '../../../../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js',
];
const ZOD = '../../../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/index.js';
const WORKER = [
  '../../src/worker/engine.worker.ts',
  '../../../../packages/engine/src/index.ts',
  '../../../../node_modules/.pnpm/@ciatlas+core@x/node_modules/@ciatlas/core/src/project-browser.ts',
  ZOD,
];

describe('the chunk rules', () => {
  it('pass the page and the worker as the app builds them', () => {
    expect(chunkProblems('index-abc.js', PAGE)).toEqual([]);
    expect(chunkProblems('engine.worker-abc.js', WORKER)).toEqual([]);
  });

  it('flag the empty module a client build puts in place of a Node built-in, in any chunk', () => {
    // Vite folds every built-in into one module and lists it among the map's sources.
    for (const [file, sources] of [
      ['index-abc.js', PAGE],
      ['engine.worker-abc.js', WORKER],
    ] as const) {
      const problems = chunkProblems(file, [...sources, '../../../__vite-browser-external']);
      expect(problems).toEqual([expect.stringContaining(`${file} imports a Node built-in`)]);
    }
    expect(chunkProblems('index-abc.js', [...PAGE, '__vite-browser-external:node:fs'])).toHaveLength(1);
  });

  it('keep the Node host out of every chunk', () => {
    const files = '../../../../packages/node/src/files.ts';
    expect(chunkProblems('index-abc.js', [...PAGE, files])).toEqual([
      `index-abc.js holds ${files}, which runs only under Node`,
    ]);
    expect(chunkProblems('engine.worker-abc.js', [...WORKER, files])).toHaveLength(1);
  });

  it("keep core, zod and the engine proper in the worker, which builds from core's browser entry", () => {
    expect(
      chunkProblems('index-abc.js', [...PAGE, '../../../../packages/engine/src/trigger/push.ts']),
    ).toEqual([
      'index-abc.js holds ../../../../packages/engine/src/trigger/push.ts: the page may use only plan/ and render/',
    ]);
    expect(chunkProblems('index-abc.js', [...PAGE, ZOD])).toHaveLength(1);
    expect(
      chunkProblems(
        'engine.worker-abc.js',
        WORKER.filter((s) => !s.includes('project-browser')),
      ),
    ).toEqual(["engine.worker-abc.js was not built from core's browser entry"]);
  });
});

describe('the stylesheet rule', () => {
  it('flags a font face inlined as a data: URI, which font-src self refuses', () => {
    const face = (src: string) =>
      `@font-face{font-family:Mono;font-display:swap;src:${src}format("woff2-variations")}`;
    expect(stylesheetProblems('index-abc.css', face('url(data:font/woff2;base64,d09GMgABAAAA)'))).toEqual([
      expect.stringContaining('index-abc.css inlines a font as a data: URI'),
    ]);
    expect(
      stylesheetProblems('index-abc.css', face(`url("data:application/font-woff2;base64,d09G")`)),
    ).toHaveLength(1);
    expect(stylesheetProblems('index-abc.css', face('url(/assets/mono-latin-B9CIFXIH.woff2)'))).toEqual([]);
    // img-src allows data:, so an inlined image is fine.
    expect(
      stylesheetProblems('index-abc.css', '.x{background:url(data:image/svg+xml;base64,PHN2Zz4=)}'),
    ).toEqual([]);
  });
});

/** The declarations of the rule an opening pattern matches, by property. */
function declarations(css: string, opening: RegExp): Record<string, string> {
  const body = new RegExp(`${opening.source}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const pairs = body.split(';').map((d) => d.split(':').map((part) => part.trim()));
  return Object.fromEntries(pairs.filter(([property, value]) => property && value));
}

describe("what the web app's Vite config builds", () => {
  let dir = '';
  let assets: string[] = [];
  const read = (file: string) => readFileSync(join(dir, 'dist/assets', file), 'utf8');
  const stylesheet = () => assets.filter((f) => f.endsWith('.css'));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'simulci-web-bundle-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>');
    writeFileSync(
      join(dir, 'main.js'),
      [
        `import ${JSON.stringify(join(web, 'src/index.css'))};`,
        "import './face.css';",
        "import { readFileSync } from 'node:fs';",
        'console.log(readFileSync);',
      ].join('\n'),
    );
    // Under Vite's 4 kB inline limit, whatever the font packages ship.
    writeFileSync(join(dir, 'small.woff2'), Buffer.alloc(2048, 1));
    writeFileSync(
      join(dir, 'face.css'),
      "@font-face { font-family: Probe; src: url('./small.woff2') format('woff2'); }\n",
    );
    const vite = await import(pathToFileURL(createRequire(join(web, 'package.json')).resolve('vite')).href);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await vite.build({
        root: dir,
        configFile: join(web, 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir: join(dir, 'dist') },
      });
    } finally {
      process.env.NODE_ENV = env;
    }
    assets = readdirSync(join(dir, 'dist/assets'));
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps every font a file, which font-src self allows, the 2 kB Cyrillic-extended JetBrains Mono face too', () => {
    expect(stylesheet()).toHaveLength(1);
    for (const file of stylesheet()) expect(stylesheetProblems(file, read(file))).toEqual([]);
    expect(
      assets.filter((f) => /^(small|jetbrains-mono-cyrillic-ext-wght-normal)-.*\.woff2$/.test(f)),
    ).toHaveLength(2);
  });

  it('keys the dark ramp on data-theme, which public/theme.js sets before the first paint', () => {
    const css = stylesheet().map(read).join('\n');
    const dark = declarations(css, /:root\[data-theme=['"]?dark['"]?\]/);
    expect(dark['color-scheme']).toBe('dark');
    expect(Object.keys(dark).length).toBeGreaterThan(10);
  });

  it('leaves a Node built-in where the chunk rules see it', () => {
    const chunk = assets.find((f) => f.endsWith('.js'))!;
    const sources: string[] = JSON.parse(read(`${chunk}.map`)).sources;
    expect(chunkProblems(chunk, sources)).toEqual([
      expect.stringContaining(`${chunk} imports a Node built-in`),
    ]);
  });
});

describe('applyTheme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sets data-theme to the theme the author chose, or to the OS scheme while it follows the system', () => {
    const attributes: Record<string, string> = {};
    let onChange: (() => void) | undefined;
    const query = {
      matches: true,
      addEventListener: (_: string, f: () => void) => (onChange = f),
      removeEventListener: () => (onChange = undefined),
    };
    vi.stubGlobal('document', {
      documentElement: { setAttribute: (k: string, v: string) => (attributes[k] = v) },
    });
    vi.stubGlobal('window', { matchMedia: () => query });
    applyTheme('system');
    expect(attributes['data-theme']).toBe('dark');
    query.matches = false;
    onChange?.();
    expect(attributes['data-theme']).toBe('light');
    applyTheme('dark');
    expect(attributes['data-theme']).toBe('dark');
    expect(onChange).toBeUndefined();
    applyTheme('light');
    expect(attributes['data-theme']).toBe('light');
  });
});
