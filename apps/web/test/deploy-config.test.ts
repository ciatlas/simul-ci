// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { config as zodConfig } from 'zod';
import { describeViolation } from '../src/worker/csp';
import { themeFor } from '../src/yaml/extensions';
// oxlint-disable-next-line import/no-unassigned-import -- what the engine worker imports, for its side effect
import '../src/worker/jitless';
import { headersFor, isNotFound, pathOf, readVercelConfig, servesFile } from '../vercel-headers.ts';

/**
 * What the deployment serves (vercel.json, read the way vercel-headers.ts reads it for `vite preview`), how the
 * preview finds the file a path names, and what the workers load first so that the CSP's refusals inside a worker are
 * seen (csp.ts, in both) and zod causes none (jitless.ts, in the engine worker). CodeMirror's styles go into a
 * constructed sheet, which the CSP's style-src allows, rather than a `<style>` element, which it refuses
 * (patches/style-mod@4.1.4.patch).
 */

const vercel = readVercelConfig();
const csp = (pathname: string): Record<string, string> =>
  Object.fromEntries(
    (headersFor(vercel, pathname).get('content-security-policy') ?? '')
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...values]) => [name, values.join(' ')]),
  );

const POLICY = {
  'default-src': "'self'",
  'script-src': "'self'",
  'worker-src': "'self'",
  'connect-src': "'none'",
  'img-src': "'self' data:",
  'style-src': "'self'",
  'font-src': "'self'",
  'base-uri': "'none'",
  'frame-ancestors': "'none'",
  'form-action': "'none'",
};

/** A source's text outside its parenthesised groups, where path-to-regexp and a regular expression read alike. */
function outsideGroups(source: string): string {
  let depth = 0;
  let out = '';
  for (const char of source) {
    if (char === '(') depth++;
    if (depth === 0) out += char;
    if (char === ')') depth--;
  }
  return out;
}

describe('vercel.json', () => {
  it('writes every source so that Vercel and a regular expression read it alike: no :name, nothing special outside a group', () => {
    for (const { source } of [...vercel.headers, ...vercel.rewrites]) {
      expect(() => new RegExp(source)).not.toThrow();
      expect(outsideGroups(source)).toMatch(/^[\w/-]*$/);
    }
    expect(outsideGroups('/assets/:path*')).not.toMatch(/^[\w/-]*$/);
    expect(outsideGroups('/theme.js')).not.toMatch(/^[\w/-]*$/);
  });

  it('sends the CSP with every response, the page, its scripts and the worker scripts', () => {
    for (const path of ['/', '/some/link', '/theme.js', '/assets/index-a1.js', '/assets/engine.worker-a1.js'])
      expect(csp(path)).toEqual(POLICY);
  });

  it('caches hashed assets for good and has everything else revalidated', () => {
    const cache = (path: string) => headersFor(vercel, path).get('cache-control');
    expect(cache('/assets/index-a1.js')).toBe('public, max-age=31536000, immutable');
    expect(cache('/assets/mona-sans-latin-wdth-normal-a1.woff2')).toBe('public, max-age=31536000, immutable');
    for (const path of ['/', '/index.html', '/theme.js', '/some/link'])
      expect(cache(path)).toBe('public, max-age=0, must-revalidate');
  });

  it('answers a deep link with the page and a missing chunk with a 404', () => {
    expect(isNotFound(vercel, '/some/link', false)).toBe(false);
    expect(isNotFound(vercel, '/assets/index-gone.js', false)).toBe(true);
    expect(isNotFound(vercel, '/assets/index-a1.js', true)).toBe(false);
  });
});

describe('the preview finds the file a path names', () => {
  const dist = mkdtempSync(join(tmpdir(), 'simulci-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'index-a1.js'), '');
  writeFileSync(join(dist, 'index.html'), '');
  afterAll(() => rmSync(dist, { recursive: true }));

  it('in dist, never a directory', () => {
    expect(servesFile(dist, '/assets/index-a1.js')).toBe(true);
    expect(servesFile(dist, '/index.html')).toBe(true);
    for (const path of ['/', '/assets', '/assets/', '/assets/index-gone.js'])
      expect(servesFile(dist, path)).toBe(false);
  });

  it('never outside dist, and an encoded slash stays part of a name', () => {
    expect(pathOf('/assets/..%2F..%2Fpackage.json')).toBe('/assets/..%2F..%2Fpackage.json');
    expect(servesFile(dist, pathOf('/assets/..%2F..%2Fpackage.json'))).toBe(false);
    expect(servesFile(dist, '/../package.json')).toBe(false);
    expect(pathOf('/%E0%A4%A')).toBe('/%E0%A4%A');
    expect(pathOf('/some%20link?wf=ci.yml')).toBe('/some link');
  });
});

describe('the workers under the CSP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('load csp.ts before anything else, and the engine worker jitless.ts before the engine', () => {
    const imports = (file: string): string[] =>
      [
        ...readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), '../src/worker', file),
          'utf8',
        ).matchAll(/^import .*?'([^']+)';$/gm),
      ].map((m) => m[1]!);
    const engine = imports('engine.worker.ts');
    expect(engine.slice(0, 2)).toEqual(['./csp', './jitless']);
    expect(engine).toContain('@simulci/engine');
    expect(imports('layout.worker.ts')[0]).toBe('./csp');
  });

  it('say what the CSP refused as an error on the console', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = Object.assign(new Event('securitypolicyviolation'), {
      blockedURI: 'eval',
      effectiveDirective: 'script-src',
      sourceFile: 'https://x.test/assets/engine.worker-a1.js',
      lineNumber: 145,
    });
    dispatchEvent(event);
    expect(error).toHaveBeenCalledWith(
      'the CSP refused eval (script-src) at https://x.test/assets/engine.worker-a1.js:145',
    );
    const inline = { blockedURI: '', effectiveDirective: 'style-src', sourceFile: 'x.js', lineNumber: 1 };
    expect(describeViolation(inline as SecurityPolicyViolationEvent)).toBe(
      'the CSP refused an inline source (style-src) at x.js:1',
    );
  });

  it('build zod parsers without new Function', () => {
    expect(zodConfig().jitless).toBe(true);
  });
});

describe('CodeMirror under the CSP', () => {
  it('mounts its styles in a constructed sheet, never a <style> element', () => {
    const view = new EditorView({ parent: document.body, extensions: themeFor(false) });
    try {
      expect(document.querySelectorAll('style')).toHaveLength(0);
      const rules = document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText));
      expect(rules.some((rule) => rule.includes('.cm-scroller'))).toBe(true);
    } finally {
      view.destroy();
    }
  });
});
