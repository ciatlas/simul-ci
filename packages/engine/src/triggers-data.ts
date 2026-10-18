/**
 * Facts from docs.github.com the trigger matcher relies on. `fixtures/triggers/*.yml` holds the same facts with the
 * sentence each rests on; a test keeps this file equal to them.
 */

/** Events with activity types: every type, and the ones that apply when `types:` is omitted. */
export const ACTIVITY_TYPES: Record<string, { types: string[]; default: string[] }> = {
  branch_protection_rule: {
    types: ['created', 'edited', 'deleted'],
    default: ['created', 'edited', 'deleted'],
  },
  check_run: {
    types: ['created', 'rerequested', 'completed', 'requested_action'],
    default: ['created', 'rerequested', 'completed', 'requested_action'],
  },
  check_suite: { types: ['completed'], default: ['completed'] },
  discussion: {
    types: [
      'created',
      'edited',
      'deleted',
      'transferred',
      'pinned',
      'unpinned',
      'labeled',
      'unlabeled',
      'locked',
      'unlocked',
      'category_changed',
      'answered',
      'unanswered',
    ],
    default: [
      'created',
      'edited',
      'deleted',
      'transferred',
      'pinned',
      'unpinned',
      'labeled',
      'unlabeled',
      'locked',
      'unlocked',
      'category_changed',
      'answered',
      'unanswered',
    ],
  },
  discussion_comment: { types: ['created', 'edited', 'deleted'], default: ['created', 'edited', 'deleted'] },
  issue_comment: { types: ['created', 'edited', 'deleted'], default: ['created', 'edited', 'deleted'] },
  issues: {
    types: [
      'opened',
      'edited',
      'deleted',
      'transferred',
      'pinned',
      'unpinned',
      'closed',
      'reopened',
      'assigned',
      'unassigned',
      'labeled',
      'unlabeled',
      'locked',
      'unlocked',
      'milestoned',
      'demilestoned',
      'typed',
      'untyped',
      'field_added',
      'field_removed',
    ],
    default: [
      'opened',
      'edited',
      'deleted',
      'transferred',
      'pinned',
      'unpinned',
      'closed',
      'reopened',
      'assigned',
      'unassigned',
      'labeled',
      'unlabeled',
      'locked',
      'unlocked',
      'milestoned',
      'demilestoned',
      'typed',
      'untyped',
      'field_added',
      'field_removed',
    ],
  },
  label: { types: ['created', 'edited', 'deleted'], default: ['created', 'edited', 'deleted'] },
  merge_group: { types: ['checks_requested'], default: ['checks_requested'] },
  milestone: {
    types: ['created', 'closed', 'opened', 'edited', 'deleted'],
    default: ['created', 'closed', 'opened', 'edited', 'deleted'],
  },
  pull_request: {
    types: [
      'assigned',
      'unassigned',
      'labeled',
      'unlabeled',
      'opened',
      'edited',
      'closed',
      'reopened',
      'synchronize',
      'converted_to_draft',
      'locked',
      'unlocked',
      'enqueued',
      'dequeued',
      'milestoned',
      'demilestoned',
      'ready_for_review',
      'review_requested',
      'review_request_removed',
      'auto_merge_enabled',
      'auto_merge_disabled',
    ],
    default: ['opened', 'synchronize', 'reopened'],
  },
  pull_request_review: {
    types: ['submitted', 'edited', 'dismissed'],
    default: ['submitted', 'edited', 'dismissed'],
  },
  pull_request_review_comment: {
    types: ['created', 'edited', 'deleted'],
    default: ['created', 'edited', 'deleted'],
  },
  pull_request_target: {
    types: [
      'assigned',
      'unassigned',
      'labeled',
      'unlabeled',
      'opened',
      'edited',
      'closed',
      'reopened',
      'synchronize',
      'converted_to_draft',
      'locked',
      'unlocked',
      'enqueued',
      'dequeued',
      'milestoned',
      'demilestoned',
      'ready_for_review',
      'review_requested',
      'review_request_removed',
      'auto_merge_enabled',
      'auto_merge_disabled',
    ],
    default: ['opened', 'synchronize', 'reopened'],
  },
  registry_package: { types: ['published', 'updated'], default: ['published', 'updated'] },
  release: {
    types: ['published', 'unpublished', 'created', 'edited', 'deleted', 'prereleased', 'released'],
    default: ['published', 'unpublished', 'created', 'edited', 'deleted', 'prereleased', 'released'],
  },
  watch: { types: ['started'], default: ['started'] },
  workflow_run: {
    types: ['completed', 'requested', 'in_progress'],
    default: ['completed', 'requested', 'in_progress'],
  },
};

/** The events whose `types:` are the custom `event_type` strings of the dispatch; any type when omitted. */
export const CUSTOM_TYPES_EVENTS: ReadonlySet<string> = new Set(['repository_dispatch']);

/** Commit-message strings that skip `push` and `pull_request` runs (exact substrings). */
export const SKIP_MARKERS: readonly string[] = [
  '[skip ci]',
  '[ci skip]',
  '[no ci]',
  '[skip actions]',
  '[actions skip]',
];

/** The `skip-checks` trailer, on its own line at the end of the message. */
export const SKIP_TRAILER = /^skip-checks: ?true$/m;

/** The events whose runs skip markers apply to. */
export const SKIP_EVENTS: ReadonlySet<string> = new Set(['push', 'pull_request']);

/** The events that read `paths`/`paths-ignore`. */
export const PATH_FILTER_EVENTS: ReadonlySet<string> = new Set([
  'push',
  'pull_request',
  'pull_request_target',
]);

/** The events whose `branches` filters are matched against the pull request's base (target) branch. */
export const BASE_BRANCH_EVENTS: ReadonlySet<string> = new Set([
  'pull_request',
  'pull_request_target',
  'merge_group',
]);
