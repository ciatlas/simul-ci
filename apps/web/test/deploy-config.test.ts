// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config as zodConfig } from 'zod';
import { describeViolation } from '../src/worker/csp';
// oxlint-disable-next-line import/no-unassigned-import -- what the engine worker imports, for its side effect
import '../src/worker/jitless';
import { headersFor, isNotFound, readVercelConfig } from '../vercel-headers';

/**
 * What the deployment serves (vercel.json, read the way vercel-headers.ts reads it for `vite preview`), and the two
 * modules each worker loads first so that the CSP's refusals inside a worker are seen and zod causes none.
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
  'style-src': "'self' 'unsafe-inline'",
  'font-src': "'self'",
  'base-uri': "'none'",
  'frame-ancestors': "'none'",
  'form-action': "'none'",
};

describe('vercel.json', () => {
  it('writes every source as a regular expression', () => {
    for (const { source } of [...vercel.headers, ...vercel.rewrites])
      expect(() => new RegExp(source)).not.toThrow();
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

describe('the workers under the CSP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
