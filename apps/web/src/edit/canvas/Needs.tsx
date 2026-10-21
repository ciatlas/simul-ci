import { useMemo, useState } from 'react';
import { useApp, useSession } from '../../app/providers';
import { documents } from '../documents';
import { needCandidates, needsOf } from '../needs';
import { RefusalNote } from '../Refusal';
import { addNeed, removeNeed } from './actions';
import { Combobox } from './Combobox';
import { AnchoredPopover } from './Popover';
import type { GestureUi, Open } from './ui';

/**
 * What it needs (synthesis § 4.2, `n`), under the job's card: its needs as chips, each a button that takes it away,
 * and a combobox of the jobs it may come to need (none that needs it, which would loop). Enter adds the active one,
 * Backspace in the empty input takes the last need away; each is an op of its own. The needs are the text's now, so
 * typing in the pane shows here.
 */
export function NeedsPopover({
  open,
  ui,
  onClose,
}: {
  open: Extract<Open, { kind: 'needs' }>;
  ui: GestureUi;
  onClose: () => void;
}) {
  const { store } = useApp();
  const rev = useSession((s) => s.files.revs[open.file]);
  const doc = useMemo(() => documents(store).of(store.getState(), open.file), [store, open.file, rev]);
  const [query, setQuery] = useState('');
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const needs = doc ? needsOf(doc, open.job) : undefined;
  const options = useMemo(() => {
    const typed = query.trim().toLowerCase();
    const candidates = doc ? needCandidates(doc, open.job) : [];
    return candidates.filter((id) => id.toLowerCase().includes(typed)).map((id) => ({ key: id, label: id }));
  }, [doc, open.job, query]);
  const at = { file: open.file, rev: rev ?? open.rev, job: open.job };
  const add = (need: string): void => {
    const result = addNeed(store, at, need);
    setRefusedSeq(result && !result.ok ? result.refused.seq : undefined);
    setQuery('');
  };
  const remove = (need: string): void => removeNeed(store, ui, at, need);
  const title = `What ${open.job} needs`;
  return (
    <AnchoredPopover anchor={open.anchor} side="below" label={title} onClose={onClose} className="w-64">
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold text-sm">{title}</h2>
        {needs === undefined ? (
          <p className="text-muted">
            The needs of {open.job} are not a list of job names; edit them in the YAML pane.
          </p>
        ) : (
          <>
            <ul aria-label={`${open.job} needs`} className="flex flex-wrap gap-1">
              {needs.length === 0 && <li className="text-muted">nothing yet</li>}
              {needs.map((need) => (
                <li key={need}>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded border border-border bg-chrome px-1.5 py-0.5 font-mono hover:border-border-strong"
                    aria-label={`Remove ${need}`}
                    onClick={() => remove(need)}
                  >
                    {need} <span aria-hidden="true">✕</span>
                  </button>
                </li>
              ))}
            </ul>
            <Combobox
              label={`Add a need to ${open.job}`}
              query={query}
              onQuery={setQuery}
              options={options}
              onPick={(o) => add(o.key)}
              {...(needs.length > 0 ? { onBackspace: () => remove(needs.at(-1)!) } : {})}
              placeholder="a job"
              empty={
                query.trim()
                  ? `No job matches ${query.trim()}.`
                  : 'No other job can be needed without a loop.'
              }
              autoFocus
            />
          </>
        )}
        <RefusalNote seq={refusedSeq} />
      </div>
    </AnchoredPopover>
  );
}
