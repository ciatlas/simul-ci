/**
 * The rules the browser bundle keeps, as pure functions over one built asset: a chunk's name and the sources its
 * source map lists, or a stylesheet's name and code. scripts/check-web-bundle.mjs applies them to apps/web/dist; the
 * tests apply them to small inputs and to what the web app's Vite config builds.
 */

/** What may only appear in the worker chunk. */
const WORKER_ONLY = [
  /@ciatlas\/core\//,
  /\/@actions\//,
  /\/zod\//,
  /\/yaml\//,
  /picomatch/,
  /\/elkjs\//,
  /cronstrue/,
];
/** Engine sources the page may use: the core-free entries. */
const PAGE_ENGINE_OK = /packages\/engine\/src\/(plan|render)\//;
const ENGINE = /packages\/engine\/src\//;
/** The Node host (@simulci/node): it reads the checkout from disk, which neither the page nor the worker can. */
const NODE_HOST = /packages\/node\/src\//;
/**
 * The module a Vite client build puts in place of a Node built-in. In production it is `module.exports = {}`, so the
 * build passes and the call fails in the browser. The code keeps no trace of the import; the source map lists the
 * module, as `__vite-browser-external` (or `__vite-browser-external:node:fs` outside production).
 */
const BROWSER_EXTERNAL = /(?:^|\/)__vite-browser-external(?::|$)/;
/** A font face whose source is a data: URI. */
const DATA_FONT = /@font-face\s*\{[^}]*url\(\s*['"]?data:/;

/** Whether a chunk is the engine worker's. */
const isWorkerChunk = (file) => file.startsWith('engine.worker-');

/**
 * What breaks the contract in one JavaScript chunk.
 * @param {string} file the chunk's name under assets/
 * @param {readonly string[]} sources the sources its map lists
 * @returns {string[]}
 */
export function chunkProblems(file, sources) {
  const problems = [];
  for (const s of sources) {
    if (BROWSER_EXTERNAL.test(s))
      problems.push(
        `${file} imports a Node built-in, which the browser build replaced with an empty module (the build log says which: "externalized for browser compatibility")`,
      );
    if (NODE_HOST.test(s)) problems.push(`${file} holds ${s}, which runs only under Node`);
  }
  problems.push(...(isWorkerChunk(file) ? workerProblems(file, sources) : pageProblems(file, sources)));
  return problems;
}

/** The worker builds from core's browser entry, without its file-system and git modules. */
function workerProblems(file, sources) {
  const problems = [];
  if (!sources.some((s) => s.includes('project-browser')))
    problems.push(`${file} was not built from core's browser entry`);
  for (const s of sources)
    if (/node-fs\.ts|\/git\.ts/.test(s) && s.includes('@ciatlas/core')) problems.push(`${file} holds ${s}`);
  return problems;
}

/** The page holds none of the engine but its plan/ and render/ entries, and nothing that only the worker may. */
function pageProblems(file, sources) {
  const problems = [];
  for (const s of sources) {
    if (WORKER_ONLY.some((re) => re.test(s))) problems.push(`${file} holds ${s}, which only the worker may`);
    if (ENGINE.test(s) && !PAGE_ENGINE_OK.test(s))
      problems.push(`${file} holds ${s}: the page may use only plan/ and render/`);
  }
  return problems;
}

/**
 * What breaks the contract in one stylesheet: a font inlined as a data: URI, which the deployment's CSP
 * (`font-src 'self'`, apps/web/vercel.json) refuses, so its glyphs fall back to another face.
 * @param {string} file the stylesheet's name under assets/
 * @param {string} code its text
 * @returns {string[]}
 */
export function stylesheetProblems(file, code) {
  return DATA_FONT.test(code)
    ? [`${file} inlines a font as a data: URI, which font-src 'self' refuses; keep fonts as files`]
    : [];
}
