import { freeId } from '@simulci/document';
import { useCallback, useId, useMemo, useState } from 'react';
import { useModal } from '../../app/modal';
import { useApp, useSession } from '../../app/providers';
import { newestOutline, type SessionStore } from '../../state/store';
import { addJob } from '../canvas/actions';
import { Combobox } from '../canvas/Combobox';
import type { GestureUi, PaletteOpen } from '../canvas/ui';
import { useCatalog } from '../catalog';
import { type Dispatched, dispatch } from '../dispatch';
import { documents } from '../documents';
import { RefusalNote } from '../Refusal';
import { stepWords } from '../steps/actions';
import { type Entry, paletteEntries } from './entries';

/**
 * The palette (synthesis § 4.8; `s`, Mod+K, + between steps, + Add step, Uses → Change…): a modal dialog with a
 * combobox over this repository's actions and callable workflows, what the repository uses with its counts and refs,
 * the bundled catalog's common actions (its chunk fetched as the palette opens), a typed `owner/repo@ref`, and Run a
 * script. Picking an action inserts a step that writes `uses: <ref>` and nothing else, after the selected step or last
 * in the job, and selects it with Properties open, where its inputs are; Run a script inserts a `run:` step and puts
 * the focus in its Run; calling a workflow adds a job after this one. Changing a step's action writes its `uses:` alone.
 */

export function Palette({ open, ui, onClose }: { open: PaletteOpen; ui: GestureUi; onClose: () => void }) {
  const { store } = useApp();
  const id = useId();
  const outline = useSession(newestOutline);
  const dialog = useModal(onClose);
  const [query, setQuery] = useState('');
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const mode = open.change ? 'change' : 'add';
  const { catalog, failed } = useCatalog();
  const entries = useMemo(
    () => paletteEntries(outline, open.file, query, mode, catalog),
    [outline, open.file, query, mode, catalog],
  );
  const pick = useCallback(
    (entry: Entry): void => {
      const result = insert(store, ui, open, entry);
      if (result.ok) dialog.current?.close();
      else setRefusedSeq(result.refused.seq);
    },
    [store, ui, open, dialog],
  );
  const title = open.change
    ? `Change the action of ${stepWords(open.job, open.index, open.change)}`
    : `Add a step to ${open.job}`;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      className="mx-auto mt-[12vh] mb-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-3 text-text text-xs backdrop:bg-black/30"
    >
      <div className="flex flex-col gap-2">
        <h2 id={`${id}-title`} className="font-semibold text-sm">
          {title}
        </h2>
        <Combobox
          label={open.change ? 'Actions' : 'Steps to add'}
          query={query}
          onQuery={setQuery}
          options={entries}
          onPick={(o) => pick(o as Entry)}
          placeholder="owner/repo@ref, ./.github/actions/…, run"
          empty={
            query.trim()
              ? `Nothing here matches ${query.trim()}. Type owner/repo@ref to use any action.`
              : 'This repository uses no actions yet.'
          }
        />
        <RefusalNote seq={refusedSeq} />
        <p className="text-muted">
          Inserts <code className="font-mono">uses:</code> and nothing else; inputs are set in Properties.{' '}
          {failed
            ? 'The common actions could not be loaded: reload the page to list them.'
            : !catalog && 'Loading the common actions…'}
        </p>
      </div>
    </dialog>
  );
}

/** What picking an entry writes, as one op. */
function insert(store: SessionStore, ui: GestureUi, open: PaletteOpen, entry: Entry): Dispatched {
  const revs = { [open.file]: open.rev };
  const { file, job, index } = open;
  if (open.change)
    return dispatch(
      store,
      {
        op: 'setStepField',
        file,
        job,
        index,
        fp: open.change,
        field: 'uses',
        value: entry.kind === 'run' ? null : entry.uses,
      },
      {
        revs,
        label: `Changed the action of ${stepWords(job, index, open.change)} to ${'uses' in entry ? entry.uses : ''}`,
      },
    );
  if (entry.kind === 'call') {
    const taken =
      documents(store)
        .of(store.getState(), file)
        ?.jobs()
        .map((j) => j.id) ?? [];
    return addJob(store, ui, open, {
      id: freeId(entry.id, taken),
      after: job,
      runsOn: '',
      needs: [],
      uses: entry.uses,
    });
  }
  // A script starts as a plain line, selected in Run: an empty `''` would keep its quotes once the author types.
  const step = entry.kind === 'run' ? { run: SCRIPT } : { uses: entry.uses };
  const label = `Added ${entry.kind === 'run' ? 'a script' : entry.uses} to ${job}`;
  const result = dispatch(store, { op: 'addStep', file, job, index, step }, { revs, label });
  if (result.ok && result.changed) {
    // Its fields are Properties': the step is selected once its plan is in, and Run waits for it there.
    if (entry.kind === 'run') store.getState().focusProperty('run');
    else showProperties(store);
  }
  return result;
}

/** The script a new run: step starts with, plain, for the author to type over. */
const SCRIPT = 'echo hello';

function showProperties(store: SessionStore): void {
  const s = store.getState();
  if (s.ui.prefs.collapsed.right) s.togglePane('right');
  s.setPanel('node');
}
