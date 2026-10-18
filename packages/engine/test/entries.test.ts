import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `@simulci/engine/plan` and `@simulci/engine/render` are what a browser's main thread may import: the plan's types,
 * lookups and renderers, nothing that pulls @ciatlas/core, zod, yaml or the parsers in. The worker alone imports the root.
 */

const SRC = resolve(import.meta.dirname, '../src');
const HEAVY = /^(@ciatlas\/core|zod|yaml|@actions\/|picomatch)/;
const ALLOWED_DIRS = ['plan/', 'render/'];
const ALLOWED_FILES = ['paths.ts'];

/** Modules reached through value imports (type-only imports are erased by the compiler). */
function reachable(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\s)[^'"]*?from\s+'([^']+)'/gm)) {
      const target = m[1]!;
      if (!target.startsWith('.')) {
        packages.add(target);
        continue;
      }
      const path = join(dirname(file), target);
      queue.push(path.endsWith('.ts') ? path : `${path}.ts`);
    }
  }
  return { files, packages };
}

describe('the plan and render entries', () => {
  for (const entry of ['plan/index.ts', 'render/index.ts']) {
    it(`${entry} reaches no heavy dependency and no module outside plan/, render/ and paths.ts`, () => {
      const { files, packages } = reachable(join(SRC, entry));
      expect([...packages].filter((p) => HEAVY.test(p))).toEqual([]);
      const outside = [...files]
        .map((f) => relative(SRC, f))
        .filter((f) => !ALLOWED_DIRS.some((d) => f.startsWith(d)) && !ALLOWED_FILES.includes(f));
      expect(outside).toEqual([]);
    });
  }

  it('the root entry still reaches the planner (the worker needs it)', () => {
    const { packages } = reachable(join(SRC, 'index.ts'));
    expect([...packages]).toContain('@ciatlas/core');
  });
});
