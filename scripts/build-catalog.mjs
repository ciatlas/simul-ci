#!/usr/bin/env node
/**
 * Builds the web app's bundled action catalog, apps/web/src/catalog/catalog.json (synthesis § 4.8). For each action
 * of TOP it records:
 * - the ref an author would write today: the major tag of its newest release (`v5`), else that release's own tag,
 *   else the branch TOP names (`release/v1`);
 * - the commit that ref points at, from `git ls-remote` (Pin to SHA writes it);
 * - its repository's licence, from GitHub's API;
 * - its interface, from the action.yml at that commit: its name, the first line of its description, its inputs (id,
 *   required, default, deprecated, the first line of the description) and the names of its outputs.
 * An action whose repository has no permissive licence keeps its input ids, defaults and outputs, and none of its
 * descriptions. Descriptions and defaults are cut to their first line, at most 140 characters.
 *
 * It needs git and the network: github.com, raw.githubusercontent.com and api.github.com. GITHUB_TOKEN or GH_TOKEN,
 * when set, authenticates the licence requests; without one they share GitHub's 60 an hour. An action that fails to
 * resolve or fetch keeps its committed entry, with a warning, so a failed refresh never empties the catalog; the file
 * is written only when it changes. --strict exits 1 after any failure.
 *
 * Usage: node scripts/build-catalog.mjs [--out <path>] [--strict]
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = 'apps/web/src/catalog/catalog.json';

/**
 * The actions, commonest first: ecosyste.ms's registry of GitHub Actions ranked by the repositories that depend on
 * them (2026-10-17), as the palette lists them. An action published on a branch names it after `@`.
 */
export const TOP = [
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
  'actions/setup-python',
  'actions/cache',
  'actions/setup-java',
  'docker/login-action',
  'actions/download-artifact',
  'docker/setup-buildx-action',
  'docker/build-push-action',
  'codecov/codecov-action',
  'actions/setup-go',
  'actions/deploy-pages',
  'actions/upload-pages-artifact',
  'docker/setup-qemu-action',
  'ruby/setup-ruby',
  'softprops/action-gh-release',
  'actions/github-script',
  'actions/stale',
  'actions/setup-dotnet',
  'peter-evans/create-pull-request',
  'actions/configure-pages',
  'docker/metadata-action',
  'actions/labeler',
  'stefanzweifel/git-auto-commit-action',
  'aws-actions/configure-aws-credentials',
  'golangci/golangci-lint-action',
  'pypa/gh-action-pypi-publish@release/v1',
  'Swatinem/rust-cache',
  'pnpm/action-setup',
  'goreleaser/goreleaser-action',
  'peter-evans/create-or-update-comment',
  'pre-commit/action',
  'dtolnay/rust-toolchain@stable',
  'hashicorp/setup-terraform',
  'tj-actions/changed-files',
  'dorny/paths-filter',
  'ossf/scorecard-action',
  'astral-sh/setup-uv',
  'oven-sh/setup-bun',
  'github/codeql-action/init',
  'github/codeql-action/analyze',
  'actions/attest-build-provenance',
  'cypress-io/github-action',
  'azure/login',
  'google-github-actions/auth',
  'dependabot/fetch-metadata',
  'amannn/action-semantic-pull-request',
  'release-drafter/release-drafter',
  'actions/create-github-app-token',
];

/** The licences under which the catalog may quote an action's descriptions. */
const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
  'Zlib',
]);

/** @param {string | null} license an SPDX id */
export const permissive = (license) => license !== null && PERMISSIVE.has(license);

/**
 * An entry of TOP as its parts: `owner/repo[/path][@ref]`.
 * @param {string} spec
 */
export function specOf(spec) {
  const at = spec.indexOf('@');
  const uses = at === -1 ? spec : spec.slice(0, at);
  const [owner = '', repo = '', ...path] = uses.split('/');
  return { uses, owner, repo, path: path.join('/'), ...(at === -1 ? {} : { ref: spec.slice(at + 1) }) };
}

/**
 * A text's first line, cut to 140 characters: an empty one stays empty (`default: ''`).
 * @param {unknown} text
 */
export function cut(text) {
  const line = String(text).trim().split(/\r?\n/)[0].trim();
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}

/**
 * A description's first line, cut to 140 characters; none when it is empty.
 * @param {unknown} text
 */
const described = (text) => (text === undefined || text === null || cut(text) === '' ? undefined : cut(text));

/**
 * The tags and branches `git ls-remote` lists, each with its commit: an annotated tag's commit (its `^{}` line) over
 * the tag object's own id.
 * @param {string} listing
 */
export function refsOf(listing) {
  /** @type {Map<string, string>} */
  const tags = new Map();
  /** @type {Map<string, string>} */
  const heads = new Map();
  for (const line of listing.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    const tag = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref);
    if (tag) {
      if (tag[2] || !tags.has(tag[1])) tags.set(tag[1], sha);
    } else if (ref.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
  }
  return { tags, heads };
}

const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * The ref of an action's newest release: the major tag (or branch: ruby/setup-ruby's `v1`) the action moves with each
 * release, when it keeps one as new as that release, else the release's own tag (`v2.4.3`); none without a release
 * or a major ref.
 * @param {ReadonlyMap<string, string>} tags
 * @param {ReadonlyMap<string, string>} [heads]
 * @returns {string | undefined}
 */
export function newestRef(tags, heads = new Map()) {
  const names = [...tags.keys()];
  const majors = [...names, ...heads.keys()].filter((t) => /^v\d+$/.test(t)).map((t) => Number(t.slice(1)));
  const releases = names
    .flatMap((t) => {
      const m = RELEASE.exec(t);
      return m ? [{ tag: t, version: m.slice(1).map(Number) }] : [];
    })
    .sort((a, b) => compare(b.version, a.version));
  const major = Math.max(-1, ...majors);
  const newest = releases[0];
  if (newest && newest.version[0] > major) return newest.tag;
  return major >= 0 ? `v${major}` : undefined;
}

/** @param {number[]} a @param {number[]} b */
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * A catalog entry from an action.yml's text and what was resolved about it.
 * @param {{ uses: string; ref: string; sha: string; license: string | null }} resolved
 * @param {string} text the action.yml
 */
export function entryOf({ uses, ref, sha, license }, text) {
  const action = parse(text);
  if (!action || typeof action !== 'object') throw new Error(`${uses}'s action.yml is not a map`);
  const quote = permissive(license);
  const inputs = Object.entries(action.inputs ?? {}).map(([id, input]) => {
    /** @type {{ id: string; required: boolean; default?: string; deprecated?: true; description?: string }} */
    const out = { id, required: input?.required === true || input?.required === 'true' };
    if (input?.default !== undefined && input.default !== null) out.default = cut(input.default);
    if (input?.deprecationMessage) out.deprecated = true;
    const description = quote ? described(input?.description) : undefined;
    if (description) out.description = description;
    return out;
  });
  const description = quote ? described(action.description) : undefined;
  return {
    uses,
    ref,
    sha,
    name: typeof action.name === 'string' ? cut(action.name) : uses,
    ...(description ? { description } : {}),
    inputs,
    outputs: Object.keys(action.outputs ?? {}),
    license,
  };
}

/**
 * The catalog from what each action of `specs` gave, in their order: a failed action keeps its committed entry, or
 * is left out when it has none, and says so.
 * @param {readonly string[]} specs
 * @param {readonly ({ entry: object } | { error: Error })[]} results one per spec
 * @param {ReadonlyMap<string, object>} committed the committed catalog's entries by `uses`
 */
export function assemble(specs, results, committed) {
  const entries = [];
  const warnings = [];
  specs.forEach((spec, i) => {
    const result = results[i];
    if (result && 'entry' in result) {
      entries.push(result.entry);
      return;
    }
    const { uses } = specOf(spec);
    const kept = committed.get(uses);
    if (kept) entries.push(kept);
    warnings.push(
      `${uses}: ${result?.error.message ?? 'not built'}; ${kept ? 'its committed entry is kept' : 'it is left out'}`,
    );
  });
  return { entries, warnings };
}

const run = promisify(execFile);

/** @param {string} owner @param {string} repo */
async function lsRemote(owner, repo) {
  const { stdout } = await run(
    'git',
    ['ls-remote', '--tags', '--heads', `https://github.com/${owner}/${repo}`],
    {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  return refsOf(stdout);
}

/** @param {string} url @param {RequestInit} [init] */
const get = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

/** @param {string} owner @param {string} repo @param {string} path @param {string} sha */
async function actionText(owner, repo, path, sha) {
  for (const name of ['action.yml', 'action.yaml']) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path ? `${path}/` : ''}${name}`;
    const res = await get(url);
    if (res.ok) return res.text();
    if (res.status !== 404) throw new Error(`${url} answered ${res.status}`);
  }
  throw new Error(`no action.yml at ${sha}`);
}

/** @param {string} owner @param {string} repo @param {string | undefined} token */
async function licenseOf(owner, repo, token) {
  const res = await get(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`api.github.com/repos/${owner}/${repo} answered ${res.status}`);
  const id = (await res.json()).license?.spdx_id;
  return typeof id === 'string' && id !== 'NOASSERTION' ? id : null;
}

/**
 * One action's entry, from the network.
 * @param {string} spec
 * @param {(owner: string, repo: string) => Promise<ReturnType<typeof refsOf>>} refs one listing per repository
 * @param {(owner: string, repo: string) => Promise<string | null>} license one request per repository
 */
async function build(spec, refs, license) {
  const { uses, owner, repo, path, ref: given } = specOf(spec);
  const { tags, heads } = await refs(owner, repo);
  const ref = given ?? newestRef(tags, heads);
  if (ref === undefined) throw new Error('no release or major tag to write');
  const sha = tags.get(ref) ?? heads.get(ref);
  if (sha === undefined) throw new Error(`no tag or branch ${ref}`);
  const [text, spdx] = await Promise.all([actionText(owner, repo, path, sha), license(owner, repo)]);
  return entryOf({ uses, ref, sha, license: spdx }, text);
}

/**
 * The results of `f` over `items`, at most `limit` at a time.
 * @template T, R
 * @param {readonly T[]} items @param {number} limit @param {(item: T) => Promise<R>} f
 */
async function mapLimit(items, limit, f) {
  /** @type {R[]} */
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Memoised by repository: codeql-action's init and analyze share one listing and one licence. */
function perRepository(/** @type {(owner: string, repo: string) => Promise<any>} */ f) {
  const known = new Map();
  return (/** @type {string} */ owner, /** @type {string} */ repo) => {
    const key = `${owner}/${repo}`.toLowerCase();
    if (!known.has(key)) known.set(key, f(owner, repo));
    return known.get(key);
  };
}

const warn = (/** @type {string} */ message) =>
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = resolve(ROOT, at === -1 ? OUT : (args[at + 1] ?? OUT));
  const strict = args.includes('--strict');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
  const before = existsSync(out) ? readFileSync(out, 'utf8') : undefined;
  const committed = new Map((before ? JSON.parse(before) : []).map((e) => [e.uses, e]));
  const refs = perRepository(lsRemote);
  const license = perRepository((owner, repo) => licenseOf(owner, repo, token));
  const results = await mapLimit(TOP, 6, (spec) =>
    build(spec, refs, license).then(
      (entry) => ({ entry }),
      (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
    ),
  );
  const { entries, warnings } = assemble(TOP, results, committed);
  for (const w of warnings) warn(w);
  if (entries.length === 0) {
    warn(`no action could be fetched and none is committed: ${relative(ROOT, out)} is not written`);
    process.exit(1);
  }
  const text = `${JSON.stringify(entries, null, 2)}\n`;
  const gzip = (gzipSync(JSON.stringify(entries)).length / 1024).toFixed(1);
  if (text === before)
    console.log(`${relative(ROOT, out)} is unchanged: ${entries.length} actions, ${gzip} kB gzipped`);
  else {
    writeFileSync(out, text);
    console.log(`wrote ${relative(ROOT, out)}: ${entries.length} actions, ${gzip} kB gzipped`);
  }
  if (strict && warnings.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
