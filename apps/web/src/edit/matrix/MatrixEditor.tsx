import type { Json, WorkflowDocument, WorkflowOp } from '@simulci/document';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { RefusalNote } from '../Refusal';
import { LineLink } from '../property/Field';
import { groupKey } from '../property/model';
import type { Target } from '../selection';
import { EntryLists } from './Entries';
import { Legs } from './Legs';
import {
  type Chip,
  chipText,
  type Dimension,
  matrixModel,
  matrixPath,
  type MatrixModel,
  replacedValue,
  splitValues,
  withValue,
} from './model';
import {
  ADD_BUTTON,
  CHIP,
  FixedPart,
  type MatrixContext,
  RemoveButton,
  SMALL_INPUT,
  useFocusOnMount,
} from './parts';
import { Strategy } from './Strategy';
import { useGesture, useVisit } from './visit';

/**
 * The matrix editor (synthesis § 4.7), a section of a job's Properties: the dimensions as rows of value chips with
 * + value and + dimension, `include` and `exclude` as rows of `key = value` chips, fail-fast and max-parallel, and the
 * plan's legs: "6 legs: 4 run · 2 skipped" over the card's leg grid. A chip shows the value as the file writes it
 * (`'3.10'` is a string), and every edit is an op through `dispatch`, typed by the ops (§ 2.7). A part set at run
 * time, or written through an alias, is shown read-only with a link to edit it in YAML. A job without `strategy:`
 * shows + matrix, which opens the editor on its first dimension.
 */
export function MatrixEditor({
  target,
  doc,
  locked,
}: {
  target: Target;
  doc: WorkflowDocument;
  locked: boolean;
}) {
  const job = target.job!;
  const ctx: MatrixContext = { file: target.file, job, rev: target.rev, locked };
  const model = useMemo(() => matrixModel(doc, job), [doc, job]);
  // + matrix opens the editor until its first dimension is written; once the strategy is gone again, + matrix is back.
  const [opened, setOpened] = useState(false);
  if (opened && model.present) setOpened(false);
  if (!model.present && !opened)
    return locked ? null : (
      <button type="button" className={ADD_BUTTON} onClick={() => setOpened(true)}>
        + matrix
      </button>
    );
  return (
    <section className="flex flex-col gap-3" aria-label="Matrix">
      <h3 className="font-medium text-muted text-xs uppercase tracking-wide">Matrix</h3>
      {model.fixed ? (
        <FixedPart label={model.fixed.part} fixed={model.fixed} file={ctx.file} />
      ) : (
        <Matrix ctx={ctx} model={model} onCancel={() => setOpened(false)} />
      )}
      {model.present && model.fixed?.part !== 'strategy' && <Strategy ctx={ctx} model={model} doc={doc} />}
      <Legs file={ctx.file} job={job} />
    </section>
  );
}

/** The dimensions, + dimension, and the `include` and `exclude` lists. */
function Matrix({ ctx, model, onCancel }: { ctx: MatrixContext; model: MatrixModel; onCancel: () => void }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        {model.dims.map((dim) => (
          <DimensionRow key={dim.name} ctx={ctx} dim={dim} />
        ))}
        {!ctx.locked && (
          <AddDimension
            ctx={ctx}
            names={model.dims.map((d) => d.name)}
            start={!model.present}
            onCancel={onCancel}
          />
        )}
      </div>
      {model.present && <EntryLists ctx={ctx} model={model} />}
    </>
  );
}

const dimOp = (ctx: MatrixContext, dim: string, values: Json[] | null): WorkflowOp => ({
  op: 'setMatrixDim',
  file: ctx.file,
  job: ctx.job,
  dim,
  values,
});

/** A dimension: its name, its line, × to remove it, its values as chips and + value. */
function DimensionRow({ ctx, dim }: { ctx: MatrixContext; dim: Dimension }) {
  const gesture = useGesture(ctx.file, ctx.rev);
  if (dim.fixed) return <FixedPart label={dim.name} fixed={dim.fixed} file={ctx.file} />;
  const chips = dim.values;
  return (
    <div className="flex flex-col gap-1" data-dimension={dim.name}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs">{dim.name}</span>
        <span className="flex items-baseline gap-1">
          <LineLink file={ctx.file} line={dim.line} />
          {!ctx.locked && (
            <RemoveButton
              label={`Remove the dimension ${dim.name}`}
              onClick={() => gesture.run(dimOp(ctx, dim.name, null))}
            />
          )}
        </span>
      </div>
      <ul className="flex flex-wrap items-center gap-1" aria-label={`Values of ${dim.name}`}>
        {chips.map((chip, i) => (
          <li key={`${i}:${chip.source}`} className="max-w-full">
            <ValueChip
              ctx={ctx}
              dim={dim.name}
              chips={chips}
              index={i}
              onRemove={() => gesture.run(dimOp(ctx, dim.name, replacedValue(chips, i, '')))}
            />
          </li>
        ))}
        {!ctx.locked && (
          <li>
            <AddValue ctx={ctx} dim={dim.name} chips={chips} />
          </li>
        )}
      </ul>
      <RefusalNote seq={gesture.refusedSeq} />
    </div>
  );
}

interface ChipProps {
  ctx: MatrixContext;
  dim: string;
  chips: readonly Chip[];
  index: number;
}

/** A value as the file writes it; a click edits it in place, × removes it. */
function ValueChip({ ctx, dim, chips, index, onRemove }: ChipProps & { onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const chip = chips[index]!;
  if (editing)
    return <ChipInput ctx={ctx} dim={dim} chips={chips} index={index} done={() => setEditing(false)} />;
  return (
    <span className={CHIP}>
      <button
        type="button"
        className="truncate rounded px-0.5 hover:bg-chrome disabled:cursor-default disabled:hover:bg-transparent"
        disabled={ctx.locked}
        aria-label={`Edit ${chip.source} in ${dim}`}
        onClick={() => setEditing(true)}
      >
        {chip.source}
      </button>
      {!ctx.locked && <RemoveButton label={`Remove ${chip.source} from ${dim}`} onClick={onRemove} />}
    </span>
  );
}

/**
 * A value edited in place: Enter or leaving commits it (nothing typed removes it), Escape puts it back. A refused
 * value stays in the input under its refusal.
 */
function ChipInput({ ctx, dim, chips, index, done }: ChipProps & { done: () => void }) {
  const shown = chipText(chips[index]!.value);
  const visit = useVisit(ctx.file, groupKey(ctx.file, [...matrixPath(ctx.job), dim, index]), shown);
  const [text, setText] = useState(shown);
  const input = useFocusOnMount<HTMLInputElement>();
  const finish = (): void => {
    if (text !== shown && !visit.commit(text, dimOp(ctx, dim, replacedValue(chips, index, text)))) return;
    visit.end();
    done();
  };
  const keys = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      visit.end();
      done();
    }
  };
  return (
    <span className="inline-flex flex-col gap-1" {...visit.focus}>
      <input
        ref={input}
        aria-label={`Value ${index + 1} of ${dim}`}
        className={`${SMALL_INPUT} w-28`}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
        onBlur={finish}
      />
      <RefusalNote seq={visit.refusedSeq} />
    </span>
  );
}

/** + value: Enter adds what is typed and leaves the input for the next one; the visit's values are one undo entry. */
function AddValue({ ctx, dim, chips }: Omit<ChipProps, 'index'>) {
  const visit = useVisit(ctx.file, groupKey(ctx.file, [...matrixPath(ctx.job), dim, '+']));
  const [text, setText] = useState('');
  const add = (): void => {
    if (text.trim() !== '' && visit.commit(text, dimOp(ctx, dim, withValue(chips, text)))) setText('');
  };
  return (
    <span className="inline-flex flex-col gap-1" {...visit.focus}>
      <input
        aria-label={`New value of ${dim}`}
        placeholder="+ value"
        className={`${SMALL_INPUT} w-24`}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          add();
        }}
      />
      <RefusalNote seq={visit.refusedSeq} />
    </span>
  );
}

/**
 * + dimension, and the row it opens: a name and its values, comma-separated, added together on Enter. Once added,
 * the focus goes back to + dimension.
 */
function AddDimension({
  ctx,
  names,
  start,
  onCancel,
}: {
  ctx: MatrixContext;
  names: readonly string[];
  start: boolean;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(start);
  const refocus = useRef(false);
  if (!open)
    return (
      <button
        ref={(button) => {
          if (!button || !refocus.current) return;
          refocus.current = false;
          button.focus();
        }}
        type="button"
        className={ADD_BUTTON}
        onClick={() => setOpen(true)}
      >
        + dimension
      </button>
    );
  return (
    <NewDimension
      ctx={ctx}
      names={names}
      close={(cancelled) => {
        refocus.current = !cancelled;
        setOpen(false);
        if (cancelled) onCancel();
      }}
    />
  );
}

function NewDimension({
  ctx,
  names,
  close,
}: {
  ctx: MatrixContext;
  names: readonly string[];
  close: (cancelled: boolean) => void;
}) {
  const { visit, name, setName, values, setValues, taken, keys, add } = useNewDimension(ctx, names, close);
  const first = useFocusOnMount<HTMLInputElement>();
  return (
    <div
      role="group"
      aria-label="New dimension"
      className="flex flex-col gap-1"
      {...visit.focus}
      onKeyDown={keys}
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={first}
          aria-label="Name of the new dimension"
          placeholder="name"
          className={`${SMALL_INPUT} w-20 shrink-0 py-1`}
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="Values of the new dimension"
          placeholder="values, comma-separated"
          className={`${SMALL_INPUT} flex-1 py-1`}
          value={values}
          spellCheck={false}
          onChange={(e) => setValues(e.target.value)}
        />
        <button
          type="button"
          className="rounded border border-border bg-surface px-2 py-1 text-xs hover:bg-chrome"
          onClick={add}
        >
          Add
        </button>
      </div>
      {taken && (
        <p className="text-danger text-xs">{taken} is a dimension already: add values to it above.</p>
      )}
      <RefusalNote seq={visit.refusedSeq} />
    </div>
  );
}

/**
 * The new dimension's name and values, and its commit: refused here when the name is a dimension already, which the
 * op would patch, replacing its values.
 */
function useNewDimension(ctx: MatrixContext, names: readonly string[], close: (cancelled: boolean) => void) {
  const visit = useVisit(ctx.file, groupKey(ctx.file, [...matrixPath(ctx.job), '+']));
  const [name, setName] = useState('');
  const [values, setValues] = useState('');
  const [taken, setTaken] = useState<string>();
  const add = (): void => {
    const dim = name.trim();
    const list = splitValues(values);
    if (dim === '' || list.length === 0) return;
    const existing = names.find((n) => n.toLowerCase() === dim.toLowerCase());
    setTaken(existing);
    if (existing || !visit.commit(`${name}:${values}`, dimOp(ctx, dim, list))) return;
    visit.end();
    close(false);
  };
  const keys = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      visit.end();
      close(true);
    }
  };
  return { visit, name, setName, values, setValues, taken, keys, add };
}
