import type { MouseEvent } from 'react';
import { useApp } from '../app/providers';
import type { PlanIndex } from '../plan/index';
import { Gate, LocLink } from './kit';
import {
  type EventBody,
  type FieldRequest,
  type FilterBody,
  type IfBody,
  type ParentBody,
  type ReadRow,
  type ReasonRowModel,
  type RowBody,
  requestField,
  selectNode,
  type Subject,
  type TypesBody,
} from './reason-rows';

/**
 * One reason of the chain (reason-rows.ts): its gate, the reason in words by kind, and on the deciding row "decided
 * here" with the line it is written on. Buttons ask the form for a field, select the parent or show an unknown's row
 * in the Unknowns tab; the focus stays in the right panel, on that row once the tab shows it.
 */
export function ReasonRow({ row, index }: { row: ReasonRowModel; index: PlanIndex }) {
  return (
    <li
      data-deciding={row.deciding || undefined}
      className={`flex gap-2 rounded border px-2 py-1.5 ${row.deciding ? 'border-accent' : 'border-transparent'}`}
    >
      <Gate gate={row.gate} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Body body={row.body} index={index} />
        {row.deciding && (
          <p className="flex flex-wrap items-center gap-1 font-medium text-text">
            decided here
            {row.loc && <LocLink loc={row.loc} />}
          </p>
        )}
      </div>
    </li>
  );
}

function Body({ body, index }: { body: RowBody; index: PlanIndex }) {
  if (body.kind === 'event') return <Listens body={body} />;
  if (body.kind === 'types') return <Types body={body} />;
  if (body.kind === 'filter') return <Filter body={body} />;
  if (body.kind === 'parent') return <Parent body={body} index={index} />;
  if (body.kind === 'if') return <If body={body} />;
  return <p>{body.text}</p>;
}

const CHIP = 'rounded bg-chrome px-1 font-mono text-text';
const BUTTON = 'rounded border border-border bg-surface px-1.5 py-0.5 text-text hover:border-border-strong';

function Chips({ items, label }: { items: readonly string[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1">
      {items.map((item) => (
        <li key={item} className={CHIP}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function SetField({ set }: { set: FieldRequest }) {
  const { store } = useApp();
  return (
    <button type="button" className={`${BUTTON} self-start`} onClick={() => requestField(store, set.path)}>
      {set.label}
    </button>
  );
}

function Listens({ body }: { body: EventBody }) {
  return (
    <>
      <p>{body.text}</p>
      <div className="flex flex-wrap items-center gap-1 text-muted">
        on: <Chips items={body.on} label="Events it listens to" />
      </div>
    </>
  );
}

function Types({ body }: { body: TypesBody }) {
  return (
    <>
      <p>{body.text}</p>
      <div className="flex flex-wrap items-center gap-1 text-muted">
        types: <Chips items={body.allowed} label="Allowed activity types" />
      </div>
      {body.set && <SetField set={body.set} />}
    </>
  );
}

function Filter({ body }: { body: FilterBody }) {
  return (
    <>
      <p>
        <code className="font-mono">{body.filter}</code> {body.text}
      </p>
      <Chips items={body.patterns} label={`${body.filter} patterns`} />
      <SubjectLine subject={body.subject} />
      {body.set && <SetField set={body.set} />}
    </>
  );
}

/** Up to this many changed files show inline; more go in a collapsed list. */
const INLINE_FILES = 3;

function SubjectLine({ subject }: { subject: Subject }) {
  const { files } = subject;
  if (files && files.length > INLINE_FILES)
    return (
      <details className="text-muted">
        <summary>
          {subject.label}: {files.length}
        </summary>
        <ul className="font-mono text-text">
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </details>
    );
  const text = files ? files.join(', ') || 'none' : subject.text;
  return (
    <p className="text-muted">
      {subject.label}: <span className="font-mono text-text">{text}</span>
    </p>
  );
}

function Parent({ body, index }: { body: ParentBody; index: PlanIndex }) {
  const { store } = useApp();
  const select = (e: MouseEvent<HTMLButtonElement>): void => {
    // The button goes with the node it belongs to: the focus waits on the tab's article, not on the page.
    e.currentTarget.closest<HTMLElement>('article')?.focus();
    selectNode(store, index, body.parent);
  };
  return (
    <p className="flex flex-wrap items-center gap-1">
      {body.text}:
      <button type="button" className={BUTTON} aria-label={`Select ${body.label}`} onClick={select}>
        {body.label}
      </button>
    </p>
  );
}

function If({ body }: { body: IfBody }) {
  return (
    <>
      {body.expr.trim() === '' ? (
        <p>No if: written</p>
      ) : (
        <p className="break-words">
          if: <code className="font-mono">{body.expr}</code>
        </p>
      )}
      {body.evaluated !== undefined && (
        <p className="break-words text-muted">
          {body.implicitSuccess ? 'evaluated with the implicit success(): ' : 'evaluated as '}
          <code className="font-mono text-text">{body.evaluated}</code>
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2">
        <dt className="text-muted">job status</dt>
        <dd>{body.status}</dd>
        <dt className="text-muted">value</dt>
        <dd className="break-words">
          {body.value}
          {body.residual !== undefined && (
            <>
              {' '}
              <span className="text-muted">residual</span> <code className="font-mono">{body.residual}</code>
            </>
          )}
        </dd>
      </dl>
      {body.reads.length > 0 && <Reads reads={body.reads} />}
    </>
  );
}

function Reads({ reads }: { reads: ReadRow[] }) {
  const from = reads.some((r) => r.from !== undefined);
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <caption className="sr-only">What the condition reads</caption>
      <thead className="text-muted">
        <tr>
          <th scope="col" className="font-normal">
            ref
          </th>
          <th scope="col" className="font-normal">
            value
          </th>
          {from && (
            <th scope="col" className="font-normal">
              from
            </th>
          )}
        </tr>
      </thead>
      <tbody className="font-mono">
        {reads.map((r) => (
          <tr key={r.ref} className="border-border border-t align-top">
            <td className="break-words pr-2">{r.ref}</td>
            <td className="break-words pr-2">
              <ReadValue read={r} />
            </td>
            {from && <td className="break-words">{r.from}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReadValue({ read }: { read: ReadRow }) {
  const { store } = useApp();
  return (
    <span className="flex flex-wrap items-center gap-1">
      {read.value}
      {read.unknowns.map((u) => (
        <button
          key={u.id}
          type="button"
          className={`${BUTTON} font-sans`}
          aria-label={`Show ${u.label} in Unknowns`}
          onClick={() => store.getState().showUnknown(u.id)}
        >
          {u.label}
        </button>
      ))}
    </span>
  );
}
