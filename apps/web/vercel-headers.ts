import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * vercel.json's routing away from Vercel: `vite preview` answers with its headers and its rewrites too, so the browser
 * pass (e2e/) runs the app under the deployment's CSP and cache rules, and the deployment smoke (e2e/deploy.spec.ts)
 * compares what a host serves with what vercel.json says. Every `source` in vercel.json is written as a plain
 * regular expression (`/assets/(.*)`, no `:name` parameters), so it reads here as one, anchored at both ends.
 */

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export interface VercelConfig {
  rewrites: { source: string; destination: string }[];
  headers: HeaderRule[];
}

const matches = (source: string, pathname: string): boolean => new RegExp(`^${source}$`).test(pathname);

export const readVercelConfig = (): VercelConfig =>
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'vercel.json'), 'utf8'),
  ) as VercelConfig;

/** The headers vercel.json gives a path, keys in lower case: every matching rule in order, a later key winning. */
export function headersFor(config: VercelConfig, pathname: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of config.headers) {
    if (!matches(rule.source, pathname)) continue;
    for (const { key, value } of rule.headers) out.set(key.toLowerCase(), value);
  }
  return out;
}

/**
 * Sets the headers now and again when the response starts: Vite's own HTML answer sets `Cache-Control: no-cache`
 * after every middleware has run, and the static files keep what was set before them.
 */
function applyOnWrite(res: ServerResponse, headers: Map<string, string>): void {
  const apply = (): void => {
    for (const [key, value] of headers) res.setHeader(key, value);
  };
  apply();
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = (...args: unknown[]) => {
    apply();
    return writeHead(...args);
  };
}

/** A path Vercel answers with 404: no file serves it and no rewrite takes it (a missing `/assets/` chunk). */
export const isNotFound = (config: VercelConfig, pathname: string, fileExists: boolean): boolean =>
  !fileExists && !config.rewrites.some((rule) => matches(rule.source, pathname));

/** The request's path as the static server reads it: decodeURI keeps an encoded `/` encoded; a bad escape stays. */
export function pathOf(url: string | undefined): string {
  const raw = new URL(url ?? '/', 'http://preview').pathname;
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

/** Whether a file of `dist` serves the path: a directory does not, and nothing outside `dist` is looked at. */
export function servesFile(dist: string, pathname: string): boolean {
  const file = resolve(dist, `.${pathname}`);
  return file.startsWith(`${dist}${sep}`) && existsSync(file) && statSync(file).isFile();
}

/** `vite preview` answers with vercel.json's headers, and with 404 where Vercel would (not with the SPA's page). */
export function vercelHeaders(config: VercelConfig = readVercelConfig()): Plugin {
  return {
    name: 'simulci:vercel-headers',
    configurePreviewServer(server) {
      const dist = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, res, next) => {
        const pathname = pathOf(req.url);
        applyOnWrite(res, headersFor(config, pathname));
        if (!isNotFound(config, pathname, servesFile(dist, pathname))) return next();
        res.statusCode = 404;
        res.end();
      });
    },
  };
}
