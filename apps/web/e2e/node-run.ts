import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ScenarioInput } from '@simulci/engine';

/**
 * The browser pass's Node helpers beside this file (node-case.ts, node-plan.ts), run with the engine's root entry, so
 * what the page wrote is checked by the CLI's code and not by the page's worker.
 */

/** Runs a helper and gives its stdout. */
function runNode(helper: string, args: string[], input?: string): string {
  const script = join(import.meta.dirname, helper);
  return execFileSync(process.execPath, ['--conditions=source', '--import', 'tsx', script, ...args], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

/** What e2e/node-case.ts prints for a test file's text. */
export interface NodeCase {
  schema: { success: boolean; issues: { path: string[]; message: string }[] };
  exitCode: number;
  summary: { passed: number; failed: number; invalid: number; skipped: number };
  cases: { name: string; status: string; failures: string[] }[];
}

/** A test file's text checked against TestFileSchema and run as `simulci test --ci` runs it, in Node. */
export const nodeCase = (text: string): NodeCase => JSON.parse(runNode('node-case.ts', [], text)) as NodeCase;

/** The starter's plan for a scenario as `simulci plan` prints it, computed in Node (e2e/node-plan.ts). */
export const nodePlan = (scenario: ScenarioInput): string =>
  runNode('node-plan.ts', [JSON.stringify(scenario)]);
