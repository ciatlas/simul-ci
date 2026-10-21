import type { Outline } from '../../worker/protocol';

/**
 * The palette's entries (synthesis § 4.8), without the bundled catalog (C8): this repository's actions and callable
 * workflows from the Outline, every `uses:` the repository has with its count and the ref it uses most, and Run a
 * script. A step's entry writes `uses: <ref>` and nothing else; a reusable workflow's adds a job that calls it. Typed
 * text narrows every section; the sections keep their order, and Used here lists the commonest first.
 */

export const SECTIONS = { here: 'In this repository', used: 'Used here', write: 'Write your own' } as const;

export type Entry =
  | { kind: 'step'; key: string; section: string; label: string; detail?: string; uses: string }
  | { kind: 'call'; key: string; section: string; label: string; detail?: string; uses: string; id: string }
  | { kind: 'run'; key: string; section: string; label: string; detail?: string };

/** What the palette was opened for: a step to add, or the action of a step to change (Properties' Change…). */
export type PaletteMode = 'add' | 'change';

export function paletteEntries(
  outline: Outline | undefined,
  file: string,
  query: string,
  mode: PaletteMode,
): Entry[] {
  const all = [...local(outline, file), ...usedHere(outline), ...(mode === 'add' ? writeOwn() : [])];
  const typed = query.trim().toLowerCase();
  return all.filter(
    (e) =>
      (mode === 'add' || e.kind === 'step') &&
      (typed === '' || `${e.label} ${e.detail ?? ''}`.toLowerCase().includes(typed)),
  );
}

/** A local action's `uses:`, from its directory: `./.github/actions/setup`, the root's `./`. */
export const localUses = (dir: string): string =>
  dir === '' || dir === '.' ? './' : `./${dir.replace(/\/+$/, '')}`;

/** This repository's actions, then the workflows that may be called but this one, by path. */
function local(outline: Outline | undefined, file: string): Entry[] {
  const actions = [...(outline?.actions ?? [])]
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .map((a): Entry => {
      const required = a.inputs.filter((i) => i.required).length;
      const detail = [
        a.name,
        required > 0 ? `${required} required input${required === 1 ? '' : 's'}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      const uses = localUses(a.dir);
      const entry: Entry = { kind: 'step', key: `local:${uses}`, section: SECTIONS.here, label: uses, uses };
      if (detail) entry.detail = detail;
      return entry;
    });
  const calls = (outline?.workflows ?? [])
    .filter((w) => w.callable && w.path !== file)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((w): Entry => {
      const uses = `./${w.path}`;
      return {
        kind: 'call',
        key: `call:${uses}`,
        section: SECTIONS.here,
        label: `Call ${uses}`,
        detail: `${w.name ? `${w.name} · ` : ''}adds a job that calls it`,
        uses,
        id: callId(w.path),
      };
    });
  return [...actions, ...calls];
}

/** The id a job calling a workflow is offered: its file name, `release` of `release.yml`. */
export function callId(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');
  const id = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z_]+/, '');
  return id === '' ? 'call' : id;
}

interface Used {
  name: string;
  refs: Map<string, number>;
  count: number;
  /** A reusable workflow called by jobs, not an action a step uses. */
  call: boolean;
}

/**
 * Every remote `uses:` of the repository's steps and jobs by `owner/repo[/path]`, with how often it is used and the
 * ref used most (the first written, on a tie), commonest first. Local ones are this repository's, listed above; a
 * `docker://` image is listed as written.
 */
export function usedHere(outline: Outline | undefined): Entry[] {
  const used = new Map<string, Used>();
  const add = (uses: string, call: boolean): void => {
    if (uses.startsWith('./') || uses.includes('${{')) return;
    const at = uses.startsWith('docker://') ? -1 : uses.lastIndexOf('@');
    const name = at === -1 ? uses : uses.slice(0, at);
    const ref = at === -1 ? '' : uses.slice(at + 1);
    const entry = used.get(name) ?? { name, refs: new Map(), count: 0, call };
    entry.count++;
    entry.refs.set(ref, (entry.refs.get(ref) ?? 0) + 1);
    used.set(name, entry);
  };
  for (const wf of outline?.workflows ?? [])
    for (const job of wf.jobs) {
      if (job.uses) add(job.uses, true);
      for (const step of job.steps) if (step.uses) add(step.uses, false);
    }
  return [...used.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((u) => {
      const ref = [...u.refs.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const uses = ref === '' ? u.name : `${u.name}@${ref}`;
      const detail = `${u.count} ${u.count === 1 ? 'use' : 'uses'} here${u.refs.size > 1 ? `, ${u.refs.size} refs` : ''}`;
      return u.call
        ? {
            kind: 'call',
            key: `used:${u.name}`,
            section: SECTIONS.used,
            label: uses,
            detail,
            uses,
            id: callId(u.name),
          }
        : { kind: 'step', key: `used:${u.name}`, section: SECTIONS.used, label: uses, detail, uses };
    });
}

function writeOwn(): Entry[] {
  return [
    {
      kind: 'run',
      key: 'run',
      section: SECTIONS.write,
      label: 'Run a script',
      detail: 'a step with run: you write',
    },
  ];
}
