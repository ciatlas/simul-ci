import type { Json, WorkflowOp } from '@simulci/document';
import { useState } from 'react';
import { RefusalNote } from '../Refusal';
import { LineLink } from '../property/Field';
import { groupKey } from '../property/model';
import {
  type Entries,
  type Entry,
  entryWith,
  entryWithout,
  matrixPath,
  type MatrixModel,
  parsePairs,
} from './model';
import { CHIP, FixedPart, type MatrixContext, RemoveButton, SMALL_INPUT } from './parts';
import { useGesture, useVisit } from './visit';

type List = 'include' | 'exclude';

/**
 * `include` and `exclude` (synthesis § 4.7, the first part to cut): each entry a row of `key = value` chips, × to
 * remove a pair or the entry, an input to add pairs to it, and one under the list for a new entry. Pairs are typed
 * `key=value`, several separated by commas; a value is typed by the values its key has in the matrix, so an entry
 * matches the legs it names.
 */
export function EntryLists({ ctx, model }: { ctx: MatrixContext; model: MatrixModel }) {
  return (
    <div className="flex flex-col gap-2">
      <EntryList ctx={ctx} list="include" entries={model.include} model={model} />
      <EntryList ctx={ctx} list="exclude" entries={model.exclude} model={model} />
    </div>
  );
}

interface ListProps {
  ctx: MatrixContext;
  list: List;
  model: MatrixModel;
}

function EntryList({ ctx, list, entries, model }: ListProps & { entries: Entries }) {
  if (entries.fixed) return <FixedPart label={list} fixed={entries.fixed} file={ctx.file} />;
  if (entries.entries.length === 0 && ctx.locked) return null;
  return (
    <div className="flex flex-col gap-1" data-list={list}>
      <span className="font-mono text-xs">{list}</span>
      {entries.entries.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={`${list} entries`}>
          {entries.entries.map((entry) => (
            <li key={entry.index}>
              <EntryRow ctx={ctx} list={list} entry={entry} model={model} />
            </li>
          ))}
        </ul>
      )}
      {!ctx.locked && (
        <PairInput
          ctx={ctx}
          list={list}
          model={model}
          label={`New ${list} entry`}
          placeholder="key=value, …"
        />
      )}
    </div>
  );
}

const entryOp = (
  ctx: MatrixContext,
  list: List,
  index: number | 'append',
  entry: Record<string, Json> | null,
): WorkflowOp => ({ op: 'setMatrixEntry', file: ctx.file, job: ctx.job, list, index, entry });

/** An entry: its number, its line and ×, then its pairs as chips and an input that adds pairs to it. */
function EntryRow({ ctx, list, entry, model }: ListProps & { entry: Entry }) {
  const gesture = useGesture(ctx.file, ctx.rev);
  const name = `${list} entry ${entry.index + 1}`;
  return (
    <div className="flex flex-col gap-1 border-border border-l pl-2" data-entry={entry.index}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted text-xs">entry {entry.index + 1}</span>
        <span className="flex items-baseline gap-1">
          <LineLink file={ctx.file} line={entry.line} />
          {!ctx.locked && (
            <RemoveButton
              label={`Remove ${name}`}
              onClick={() => gesture.run(entryOp(ctx, list, entry.index, null))}
            />
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {entry.pairs.map((pair) => (
          <span key={pair.key} className={CHIP}>
            <span className="truncate px-0.5">
              {pair.key} = {pair.source}
            </span>
            {!ctx.locked && (
              <RemoveButton
                label={`Remove ${pair.key} from ${name}`}
                onClick={() => gesture.run(entryOp(ctx, list, entry.index, entryWithout(entry, pair.key)))}
              />
            )}
          </span>
        ))}
        {!ctx.locked && (
          <PairInput
            ctx={ctx}
            list={list}
            entry={entry}
            model={model}
            label={`Add to ${name}`}
            placeholder="+ key=value"
          />
        )}
      </div>
      <RefusalNote seq={gesture.refusedSeq} />
    </div>
  );
}

/**
 * Pairs typed `key=value, …`: Enter sets them on the entry, or appends a new entry when there is none. The visit's
 * commits are one undo entry.
 */
function PairInput({
  ctx,
  list,
  entry,
  model,
  label,
  placeholder,
}: ListProps & { entry?: Entry; label: string; placeholder: string }) {
  const index = entry?.index ?? 'append';
  const visit = useVisit(
    ctx.file,
    groupKey(ctx.file, [...matrixPath(ctx.job), list, index === 'append' ? '+' : index]),
  );
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const add = (): void => {
    if (text.trim() === '') return;
    const pairs = parsePairs(text);
    setInvalid(pairs === undefined);
    if (pairs && visit.commit(text, entryOp(ctx, list, index, entryWith(entry, pairs, model)))) setText('');
  };
  return (
    <span className="inline-flex min-w-0 flex-col gap-1" {...visit.focus}>
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        className={`${SMALL_INPUT} w-36`}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          add();
        }}
      />
      {invalid && <span className="text-danger text-xs">Write key=value, separated by commas.</span>}
      <RefusalNote seq={visit.refusedSeq} />
    </span>
  );
}
