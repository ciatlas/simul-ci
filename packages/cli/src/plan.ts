import { type RunPlan, renderMermaid, renderText, type ScenarioInput, simulate } from '@simulci/engine';
import { defineCommand } from 'citty';
import { readWorkflowFiles } from './files';

/** The `simulci plan` arguments as citty parses them. */
export interface PlanArgs {
  dir: string;
  event: string;
  action?: string;
  ref?: string;
  branch?: string;
  tag?: string;
  base?: string;
  head?: string;
  changed?: string | string[];
  input?: string | string[];
  var?: string | string[];
  secret?: string | string[];
  actor?: string;
  fork?: boolean;
  message?: string;
  format: string;
  detail: string;
}

/** Builds the scenario from the arguments: `key=value` lists become records, repeated flags become arrays. */
export function scenarioFromArgs(args: PlanArgs): ScenarioInput {
  const s: ScenarioInput = { event: args.event };
  for (const key of ['action', 'ref', 'branch', 'tag', 'base', 'head', 'message'] as const) {
    const v = args[key];
    if (v !== undefined && v !== '') s[key] = v;
  }
  const changed = list(args.changed);
  if (changed.length) s.changed = changed;
  const inputs = pairs(list(args.input));
  if (Object.keys(inputs).length)
    s.inputs = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, typed(v)]));
  const vars = pairs(list(args.var));
  if (Object.keys(vars).length) s.vars = vars;
  const secrets = list(args.secret);
  if (secrets.length) s.secrets = secrets;
  if (args.actor !== undefined || args.fork) {
    s.actor = {};
    if (args.actor !== undefined) s.actor.login = args.actor;
    if (args.fork) s.actor.fork = true;
  }
  return s;
}

const list = (v: string | string[] | undefined): string[] =>
  (v === undefined ? [] : Array.isArray(v) ? v : [v])
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);

function pairs(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq === -1) out[item] = '';
    else out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

/** `true`, `false` and numbers as the typed values a dispatch input holds; anything else stays a string. */
function typed(v: string): string | boolean | number {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
}

export function render(plan: RunPlan, format: string): string {
  if (format === 'json') return `${JSON.stringify(plan, null, 2)}\n`;
  if (format === 'mermaid') return renderMermaid(plan);
  return renderText(plan);
}

export const planCommand = defineCommand({
  meta: { name: 'plan', description: 'Which jobs and steps run for a scenario, and why' },
  args: {
    dir: { type: 'string', description: 'The repository checkout', default: '.' },
    event: {
      type: 'string',
      description: 'The event (push, pull_request, workflow_dispatch, …)',
      default: 'push',
    },
    action: { type: 'string', description: 'The activity type (opened, labeled, …)' },
    ref: { type: 'string', description: 'The git ref (refs/heads/main, or a branch name)' },
    branch: { type: 'string', description: 'The branch (refs/heads/<branch>)' },
    tag: { type: 'string', description: 'The tag (refs/tags/<tag>)' },
    base: { type: 'string', description: 'The base branch of a pull request' },
    head: { type: 'string', description: 'The head branch of a pull request' },
    changed: { type: 'string', description: 'Changed files, comma-separated or repeated' },
    input: { type: 'string', description: 'A workflow_dispatch input, name=value (repeatable)' },
    var: { type: 'string', description: 'A variable, NAME=value (repeatable)' },
    secret: { type: 'string', description: 'A secret that exists, by name (repeatable)' },
    actor: { type: 'string', description: 'The actor login' },
    fork: { type: 'boolean', description: 'The pull request comes from a fork', default: false },
    message: { type: 'string', description: 'The head commit message' },
    format: { type: 'string', description: 'text, json or mermaid', default: 'text' },
    detail: { type: 'string', description: 'legs or steps', default: 'steps' },
  },
  run({ args }) {
    const a = args as unknown as PlanArgs;
    const files = readWorkflowFiles(a.dir);
    if (Object.keys(files).length === 0) {
      process.stderr.write(`no workflows under ${a.dir}/.github/workflows\n`);
      process.exitCode = 2;
      return;
    }
    const plan = simulate({
      files,
      scenario: scenarioFromArgs(a),
      detail: a.detail === 'legs' ? 'legs' : 'steps',
    });
    process.stdout.write(render(plan, a.format));
  },
});
