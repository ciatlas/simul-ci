import type { YamlPath } from '../types';

/**
 * The canonical key order of each map an op writes (§ 3.5). A new key goes after the present key ranked highest below
 * its own; with none, before the first key ranked above it; else last. Existing keys never move, and keys outside the
 * table never anchor a placement (`placement` in set.ts).
 */
export const ORDER = {
  workflow: ['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs'],
  event: [
    'types',
    'branches',
    'branches-ignore',
    'tags',
    'tags-ignore',
    'paths',
    'paths-ignore',
    'workflows',
    'inputs',
  ],
  schedule: ['cron', 'timezone'],
  input: ['description', 'required', 'default', 'type', 'options'],
  job: [
    'name',
    'runs-on',
    'needs',
    'if',
    'permissions',
    'environment',
    'concurrency',
    'timeout-minutes',
    'continue-on-error',
    'strategy',
    'container',
    'services',
    'uses',
    'with',
    'secrets',
    'env',
    'defaults',
    'outputs',
    'steps',
  ],
  strategy: ['matrix', 'fail-fast', 'max-parallel'],
  step: [
    'id',
    'name',
    'if',
    'uses',
    'run',
    'shell',
    'working-directory',
    'with',
    'env',
    'continue-on-error',
    'timeout-minutes',
  ],
  case: ['name', 'when', 'allowMaybe', 'then'],
} as const satisfies Record<string, readonly string[]>;

/** The order of the map at a path, by where it is in a workflow (or a test file's case); undefined for others. */
export function orderFor(path: YamlPath): readonly string[] | undefined {
  const [root, second, third] = path;
  if (path.length === 0) return ORDER.workflow;
  if (root === 'jobs') return jobOrder(path.length, third);
  if (root === 'on') return eventOrder(path.length, second, third);
  if (root === 'cases' && path.length === 2) return ORDER.case;
  return undefined;
}

function jobOrder(depth: number, third: unknown): readonly string[] | undefined {
  if (depth === 2) return ORDER.job;
  if (depth === 3 && third === 'strategy') return ORDER.strategy;
  if (depth === 4 && third === 'steps') return ORDER.step;
  return undefined;
}

/** `on.<event>`, an item of `on.schedule`, and a dispatch input `on.workflow_dispatch.inputs.<name>`. */
function eventOrder(depth: number, event: unknown, third: unknown): readonly string[] | undefined {
  if (depth === 2) return ORDER.event;
  if (depth === 3 && event === 'schedule') return ORDER.schedule;
  if (depth === 4 && event === 'workflow_dispatch' && third === 'inputs') return ORDER.input;
  return undefined;
}
