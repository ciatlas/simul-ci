import type { Value } from '../plan/types';
import { known, unknown } from '../plan/values';
import type { ChangedFile, ChangeStatus } from '../scenario';
import { CHANGED, changedFiles, MODIFIED, matcher } from './changes';
import { type ActionModel, knownWith, type ModelContext, matchesRepo } from './types';

/**
 * `tj-actions/changed-files`: lists and flags over the changed files that match `files` (newline-separated globs,
 * every file when absent) minus `files_ignore`, joined by `separator` (a space). "Changed" is added, modified or
 * renamed; "modified" also counts deleted. The action has many more outputs: the interface stays open.
 */

const LISTS: [string, readonly ChangeStatus[]][] = [
  ['all_changed_files', CHANGED],
  ['all_modified_files', MODIFIED],
  ['all_changed_and_modified_files', MODIFIED],
  ['added_files', ['added']],
  ['modified_files', ['modified']],
  ['deleted_files', ['removed']],
  ['renamed_files', ['renamed']],
];

const FLAGS: [string, readonly ChangeStatus[]][] = [
  ['any_changed', CHANGED],
  ['any_modified', MODIFIED],
  ['any_deleted', ['removed']],
];

const NAMES = [...LISTS.map(([n]) => n), ...LISTS.map(([n]) => `${n}_count`), ...FLAGS.map(([n]) => n)];

/** Newline-separated patterns; comments dropped; a trailing `/` means the directory's contents. */
const patternsOf = (text: string | undefined): string[] =>
  (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.endsWith('/') ? `${l}**` : l));

function selected(ctx: ModelContext, files: ChangedFile[]): ChangedFile[] | undefined {
  if (ctx.with.files !== undefined && !ctx.with.files.known) return undefined;
  if (ctx.with.files_ignore !== undefined && !ctx.with.files_ignore.known) return undefined;
  const include = patternsOf(knownWith(ctx, 'files'));
  const ignore = patternsOf(knownWith(ctx, 'files_ignore')).map((p) => (p.startsWith('!') ? p : `!${p}`));
  const patterns = [...include, ...ignore];
  const wanted = patterns.length ? matcher(patterns) : () => true;
  return files.filter((f) => wanted(f.path));
}

export const changedFilesModel: ActionModel = {
  id: 'tj-actions/changed-files',
  version: '1',
  matches: (uses) => matchesRepo('tj-actions/changed-files', uses),
  presets: [],
  preset: () => undefined,
  interface: () => ({ names: NAMES, open: true }),
  produce(ctx) {
    const files = changedFiles(ctx.scenario);
    const chosen = files ? selected(ctx, files) : undefined;
    if (chosen) return { outputs: decide(chosen, knownWith(ctx, 'separator') ?? ' ') };
    const id = (name: string) => (files ? `${ctx.node}.outputs.${name}` : 'scenario.changed');
    return { outputs: Object.fromEntries(NAMES.map((name) => [name, unknown<string>([id(name)])])) };
  },
};

/** The lists, their counts and the flags over the selected files. */
function decide(chosen: ChangedFile[], separator: string): Record<string, Value<string>> {
  const outputs: Record<string, Value<string>> = {};
  for (const [name, statuses] of LISTS) {
    const paths = chosen.filter((f) => statuses.includes(f.status)).map((f) => f.path);
    outputs[name] = known(paths.join(separator));
    outputs[`${name}_count`] = known(String(paths.length));
  }
  for (const [name, statuses] of FLAGS)
    outputs[name] = known(chosen.some((f) => statuses.includes(f.status)) ? 'true' : 'false');
  return outputs;
}
