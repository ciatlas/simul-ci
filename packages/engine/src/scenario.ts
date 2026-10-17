import { z } from 'zod';

/**
 * A scenario: the facts about one run that the engine simulates. Authors write the input shape (in a test's `when:`,
 * on the CLI, in the app); `normalizeScenario` turns it into the plan's echo with the ref resolved the way GitHub
 * resolves it for the event.
 */

export const ChangeStatusSchema = z.enum(['added', 'modified', 'removed', 'renamed']);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;

/** A changed file: a bare path means modified. */
export const ChangedFileSchema = z.union([
  z.string().min(1),
  z.strictObject({
    path: z.string().min(1),
    status: ChangeStatusSchema.default('modified'),
    /** The previous path of a renamed file. */
    from: z.string().min(1).optional(),
  }),
]);

export const ActorSchema = z.strictObject({
  login: z.string().min(1).optional(),
  /** The head of a pull request is in a fork: secrets are withheld and `pull_request_target` changes meaning. */
  fork: z.boolean().default(false),
  /** The actor is a GitHub App or a bot account (`github.actor` ends with `[bot]`). */
  bot: z.boolean().default(false),
});

export const WorkflowRunSchema = z.strictObject({
  /** The `name:` of the workflow whose run triggers this one. */
  name: z.string().min(1),
  conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped']).default('success'),
});

export const PlatformSchema = z.enum(['dotcom', 'ghes']);
export type Platform = z.infer<typeof PlatformSchema>;

export const InputValueSchema = z.union([z.string(), z.boolean(), z.number()]);

/** What an author writes. Unknown keys are errors, so a typo never silently changes a scenario. */
export const ScenarioInputSchema = z.strictObject({
  /** The event name as written under `on:` (`push`, `pull_request`, `workflow_dispatch`, …). */
  event: z.string().min(1),
  /** The activity type (`opened`, `labeled`, `completed`, …) for events that have them. */
  action: z.string().min(1).optional(),
  /** Any git ref: `refs/heads/main`, `heads/main`, `tags/v1`, or a bare branch name. Tags need `tag:` or `refs/tags/`. */
  ref: z.string().min(1).optional(),
  /** `refs/heads/<branch>`. */
  branch: z.string().min(1).optional(),
  /** `refs/tags/<tag>`. */
  tag: z.string().min(1).optional(),
  /** The base branch of a pull request (defaults to the default branch). */
  base: z.string().min(1).optional(),
  /** The head branch of a pull request. */
  head: z.string().min(1).optional(),
  /** The pull request (or issue) number. */
  number: z.number().int().positive().optional(),
  /** The head commit. */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, 'a commit SHA is 7 to 40 lowercase hex digits')
    .optional(),
  defaultBranch: z.string().min(1).default('main'),
  /** `owner/name`. */
  repository: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'a repository is written owner/name')
    .optional(),
  /** The head commit message (`[skip ci]` markers are read from it). */
  message: z.string().optional(),
  actor: ActorSchema.prefault({}),
  /** The files the push or pull request changes. Absent means unknown, so `paths` filters cannot decide. */
  changed: z.array(ChangedFileSchema).optional(),
  /** `workflow_dispatch` inputs, typed as the `inputs` context types them. */
  inputs: z.record(z.string(), InputValueSchema).default({}),
  /** Repository, environment and organization variables, merged as GitHub merges them. */
  vars: z.record(z.string(), z.string()).default({}),
  /** The names of the secrets that exist; their values stay opaque. `GITHUB_TOKEN` always exists. */
  secrets: z.array(z.string().min(1)).default([]),
  /** The deployment environments that exist. */
  environments: z.array(z.string().min(1)).optional(),
  /** For `schedule`: the cron expression that fired. */
  cron: z.string().min(1).optional(),
  /** For `workflow_run`: the run that triggers this one. */
  workflow_run: WorkflowRunSchema.optional(),
  platform: PlatformSchema.default('dotcom'),
});

export type ScenarioInput = z.input<typeof ScenarioInputSchema>;

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  from?: string;
}

/** The scenario as the plan echoes it: every shorthand resolved, every default applied. */
export interface Scenario {
  /** `event[.action]:<ref name>[:fork]`; a stable label for a scenario, not unique across inputs. */
  id: string;
  event: string;
  action?: string;
  /** `github.ref`, when it is known for the event. */
  ref?: string;
  /** `github.ref_name`. */
  refName?: string;
  /** `github.ref_type`. */
  refType?: 'branch' | 'tag';
  /** `github.base_ref`, set for pull requests. */
  baseRef?: string;
  /** `github.head_ref`, set for pull requests. */
  headRef?: string;
  number?: number;
  sha?: string;
  defaultBranch: string;
  repository?: string;
  message?: string;
  actor: { login?: string; fork: boolean; bot: boolean };
  changed?: ChangedFile[];
  inputs: Record<string, string | boolean | number>;
  vars: Record<string, string>;
  secrets: string[];
  environments?: string[];
  cron?: string;
  workflow_run?: { name: string; conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' };
  platform: Platform;
}

export class ScenarioError extends Error {
  override name = 'ScenarioError';
}

/** The events whose `github.ref` is the merge ref of the pull request. */
const PULL_MERGE_REF_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment']);
/** The events whose `github.ref` is the pull request's base branch. */
const PULL_BASE_REF_EVENTS = new Set(['pull_request_target']);

/** Writes a ref the way `github.ref` spells it. A bare name is a branch: a tag needs `tag:` or `refs/tags/`. */
export function fullRef(ref: string): string {
  if (ref.startsWith('refs/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/') || ref.startsWith('pull/')) return `refs/${ref}`;
  return `refs/heads/${ref}`;
}

/** `github.ref_name` and `github.ref_type` of a full ref. */
export function refParts(ref: string): { refName: string; refType: 'branch' | 'tag' } {
  if (ref.startsWith('refs/tags/')) return { refName: ref.slice('refs/tags/'.length), refType: 'tag' };
  if (ref.startsWith('refs/heads/')) return { refName: ref.slice('refs/heads/'.length), refType: 'branch' };
  if (ref.startsWith('refs/pull/')) return { refName: ref.slice('refs/pull/'.length), refType: 'branch' };
  return { refName: ref.replace(/^refs\//, ''), refType: 'branch' };
}

/** Parses and normalizes an author's scenario; throws `ScenarioError` with every problem listed. */
export function parseScenario(input: unknown): Scenario {
  const result = ScenarioInputSchema.safeParse(input);
  if (!result.success) throw new ScenarioError(`invalid scenario:\n${z.prettifyError(result.error)}`);
  return normalizeScenario(result.data);
}

export function normalizeScenario(input: z.output<typeof ScenarioInputSchema>): Scenario {
  const given = [input.ref, input.branch, input.tag].filter((v) => v !== undefined);
  if (given.length > 1) throw new ScenarioError('give one of ref, branch or tag');
  const own = input.tag
    ? `refs/tags/${input.tag}`
    : input.branch
      ? `refs/heads/${input.branch}`
      : input.ref
        ? fullRef(input.ref)
        : undefined;

  const scenario: Scenario = {
    id: '',
    event: input.event,
    defaultBranch: input.defaultBranch,
    actor: input.actor,
    inputs: input.inputs,
    vars: input.vars,
    secrets: input.secrets,
    platform: input.platform,
  };
  if (input.action !== undefined) scenario.action = input.action;
  if (input.number !== undefined) scenario.number = input.number;
  if (input.sha !== undefined) scenario.sha = input.sha;
  if (input.repository !== undefined) scenario.repository = input.repository;
  if (input.message !== undefined) scenario.message = input.message;
  if (input.changed !== undefined)
    scenario.changed = input.changed.map((c) =>
      typeof c === 'string' ? { path: c, status: 'modified' } : c,
    );
  if (input.environments !== undefined) scenario.environments = input.environments;
  if (input.cron !== undefined) scenario.cron = input.cron;
  if (input.workflow_run !== undefined) scenario.workflow_run = input.workflow_run;

  const ref = resolveRef(input, own);
  if (ref !== undefined) {
    scenario.ref = ref;
    Object.assign(scenario, refParts(ref));
  }
  if (
    PULL_MERGE_REF_EVENTS.has(input.event) ||
    PULL_BASE_REF_EVENTS.has(input.event) ||
    input.event === 'merge_group'
  ) {
    scenario.baseRef = input.base ?? input.defaultBranch;
    if (input.head !== undefined) scenario.headRef = input.head;
  }
  scenario.id = scenarioId(scenario);
  return scenario;
}

/** `github.ref` for the event: the merge ref of a pull request, the base of a `pull_request_target`, the tag of a release, the ref given, else the default branch. */
function resolveRef(
  input: z.output<typeof ScenarioInputSchema>,
  own: string | undefined,
): string | undefined {
  const { event } = input;
  if (PULL_MERGE_REF_EVENTS.has(event)) return `refs/pull/${input.number ?? 1}/merge`;
  if (PULL_BASE_REF_EVENTS.has(event)) return `refs/heads/${input.base ?? input.defaultBranch}`;
  if (event === 'merge_group')
    return own ?? `refs/heads/gh-readonly-queue/${input.base ?? input.defaultBranch}`;
  if (event === 'release') return own?.startsWith('refs/tags/') ? own : undefined;
  // Every other event runs on the ref given, else on the default branch's last commit.
  return own ?? `refs/heads/${input.defaultBranch}`;
}

function scenarioId(s: Scenario): string {
  const event = s.action ? `${s.event}.${s.action}` : s.event;
  return `${event}:${s.refName ?? '?'}${s.actor.fork ? ':fork' : ''}`;
}
