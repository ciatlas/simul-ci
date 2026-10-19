/**
 * The starter sample's plan for a scenario as `simulci plan` prints it, computed in Node by the engine's root entry
 * and not by the page's worker: the browser pass checks the canvas against it. The sample is read from the source
 * tree, at the paths the page gives its files (src/input/samples.ts). The browser pass runs it as
 * `node --conditions=source --import tsx e2e/node-plan.ts '<scenario JSON>'`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderText, type ScenarioInput, simulate } from '@simulci/engine';

const sample = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../src/samples/starter', name), 'utf8');

const files = {
  '.github/workflows/ci.yml': sample('ci.yml'),
  '.github/workflows/release.yml': sample('release.yml'),
  '.github/actions/setup/action.yml': sample('setup-action.yml'),
};

const scenario = JSON.parse(process.argv[2] ?? '{}') as ScenarioInput;
process.stdout.write(renderText(simulate({ files, scenario, assume: [], detail: 'steps' })));
