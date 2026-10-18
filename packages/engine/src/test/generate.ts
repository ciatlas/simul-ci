import { Document, isSeq, type Node, type YAMLMap } from 'yaml';
import type { AssumeEntry } from '../mocks/schema';
import { unitPathOfId, unitPaths } from '../plan/select';
import type { Json, NodeId, RunPlan, Tri, Unknown, WorkflowPlan } from '../plan/types';
import { becauseOf, decidingReason, reasonUnknowns } from '../render/reason';
import type { ScenarioInput } from '../scenario';

/**
 * A test case from a plan (`simulci plan --as-test`, the app's "Copy as test case"): the scenario as given, and
 * what the plan holds as `then`. Every maybe becomes a comment naming the unknown and its pin, and `allowMaybe: true`,
 * so the generated case passes as a record of what is still open.
 */

export interface GenerateOptions {
  plan: RunPlan;
  /** The workflow the case is about: `ci.yml` or its full path. */
  workflow: string;
  /** The scenario as the author gave it (not the plan's normalized echo). */
  scenario: ScenarioInput;
  assume?: AssumeEntry[];
  name?: string;
  /** `jobs` lists jobs; `steps` also asserts each step's verdict under `units`. */
  detail?: 'jobs' | 'steps';
}

export interface GeneratedCase {
  name: string;
  when: Record<string, Json>;
  allowMaybe?: boolean;
  then: Record<string, Json>;
  /** `# <unit>: maybe — <unknown> → pin: …` lines for the case. */
  comments: string[];
}

export function caseFromPlan(opts: GenerateOptions): GeneratedCase {
  const wf = findWorkflow(opts.plan, opts.workflow);
  const when: Record<string, Json> = { ...(opts.scenario as Record<string, Json>) };
  if (opts.assume?.length) when.assume = opts.assume;
  const comments: string[] = [];
  const then = thenOf(wf, opts, comments);
  const out: GeneratedCase = { name: opts.name ?? nameOf(opts.scenario, opts.assume), when, then, comments };
  if (comments.length) out.allowMaybe = true;
  return out;
}

/** What the plan holds for the workflow: the deciding reason when untriggered, else the lists and the conclusion. */
function thenOf(wf: WorkflowPlan, opts: GenerateOptions, comments: string[]): Record<string, Json> {
  const then: Record<string, Json> = {};
  if (wf.triggered.verdict === 'no') {
    then.triggered = false;
    const reason = decidingReason(wf.triggered.chain, 'no');
    if (reason) then.because = becauseOf(reason);
    return then;
  }
  const paths = unitPaths(wf);
  if (wf.triggered.verdict === 'maybe') {
    then.triggered = true;
    comments.push(
      ...maybeComments(opts.plan, short(opts.workflow), wf.triggered.chain.flatMap(reasonUnknowns), paths),
    );
  }
  const lists = jobLists(wf, paths, opts.plan, comments);
  for (const [key, items] of Object.entries(lists)) if (items.length) then[key] = items;
  if (wf.conclusion.known) then.conclusion = wf.conclusion.value;
  if (opts.detail === 'steps') then.units = stepUnits(wf, paths);
  return then;
}

/** A whole test file for one case, as YAML text with the comments on the case. */
export function fileFromPlan(opts: GenerateOptions): string {
  const c = caseFromPlan(opts);
  const entry: Record<string, Json> = { name: c.name, when: c.when };
  if (c.allowMaybe) entry.allowMaybe = true;
  entry.then = c.then;
  const doc = new Document({ workflow: short(opts.workflow), cases: [entry] });
  const cases = doc.get('cases', true);
  if (isSeq(cases)) {
    const first = cases.items[0] as Node;
    if (c.comments.length) first.commentBefore = c.comments.map((l) => ` ${l}`).join('\n');
    const when = (first as YAMLMap).get('when', true) as (Node & { flow?: boolean }) | undefined;
    if (when && !c.when.assume) when.flow = true;
  }
  return doc.toString({ lineWidth: 110 });
}

function findWorkflow(plan: RunPlan, workflow: string): WorkflowPlan {
  const full = workflow.startsWith('.github/workflows/') ? workflow : `.github/workflows/${workflow}`;
  const wf = plan.workflows.find((w) => w.depth === 0 && w.path === full);
  if (!wf) throw new Error(`no workflow ${full} in the plan`);
  return wf;
}

const short = (workflow: string): string => workflow.replace(/^.*\//, '');

function jobLists(
  wf: WorkflowPlan,
  paths: Map<NodeId, string>,
  plan: RunPlan,
  comments: string[],
): Record<'run' | 'skip' | 'maybe', string[]> {
  const lists: Record<'run' | 'skip' | 'maybe', string[]> = { run: [], skip: [], maybe: [] };
  const visit = (w: WorkflowPlan): void => {
    for (const job of w.jobs) {
      const path = paths.get(job.id) ?? job.jobId;
      lists[listOf(job.runs.verdict)].push(path);
      if (job.runs.verdict === 'maybe')
        comments.push(...maybeComments(plan, path, job.runs.chain.flatMap(reasonUnknowns), paths));
      for (const leg of job.legs) if (leg.call) visit(leg.call);
    }
  };
  visit(wf);
  return lists;
}

const listOf = (verdict: Tri): 'run' | 'skip' | 'maybe' =>
  verdict === 'yes' ? 'run' : verdict === 'no' ? 'skip' : 'maybe';

function stepUnits(wf: WorkflowPlan, paths: Map<NodeId, string>): Record<string, Json> {
  const units: Record<string, Json> = {};
  for (const job of wf.jobs) {
    if (job.runs.verdict === 'no') continue;
    for (const leg of job.legs) {
      for (const step of leg.steps ?? []) {
        const path = paths.get(step.id);
        if (path) units[path] = { runs: step.runs.verdict };
      }
    }
  }
  return units;
}

function maybeComments(plan: RunPlan, path: string, ids: string[], paths: Map<NodeId, string>): string[] {
  return [...new Set(ids)].map((id) => {
    const u = plan.unknowns.find((x) => x.id === id);
    return `${path}: maybe — ${unitPathOfId(id, paths)} → ${pinText(u)}`;
  });
}

function pinText(u: Unknown | undefined): string {
  if (!u?.pin) return `(no pin: ${u?.gap ?? 'only the run decides it'})`;
  const at = u.pin.at?.length ? `${u.pin.at.join('.')}: ` : '';
  return `pin: ${at}${JSON.stringify(u.pin.fragment)}`;
}

/** `push main (2 changed files) with 1 assumption`. */
function nameOf(scenario: ScenarioInput, assume: AssumeEntry[] | undefined): string {
  const ref = [scenario.tag, scenario.branch, scenario.ref, scenario.head].find(
    (r) => r !== undefined && r !== '',
  );
  const parts = [scenario.event, scenario.action, ref].filter(
    (p): p is string => p !== undefined && p !== '',
  );
  const changed = scenario.changed?.length ?? 0;
  const assumed = assume?.length ?? 0;
  return `${parts.join(' ')}${changed ? ` (${plural(changed, 'changed file')})` : ''}${assumed ? ` with ${plural(assumed, 'assumption')}` : ''}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
