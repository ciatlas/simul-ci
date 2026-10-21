import type { Diagnostic } from '@simulci/engine';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../app/providers';
import { focusPanel } from '../app/shortcuts';
import { Mark } from '../graph/Mark';
import { copyText } from '../lib/clipboard';
import { MARK_LABEL } from '../lib/words';
import { EmptyNote, LocLink, SectionTitle, type Selected, useSelected } from './kit';
import { ReasonRow } from './ReasonRow';
import { type ReasonsHeader, reasonsModel } from './reason-rows';

/**
 * The Reasons tab (synthesis § 7): the selected node's chain of reasons, the deciding one outlined. With nothing
 * inside a workflow selected it is the focused workflow's trigger chain, so the story shows from the first paint.
 */
export function Reasons() {
  const selected = useSelected();
  if (!selected) return <EmptyNote>No plan yet: the reasons show once the first plan is in.</EmptyNote>;
  return <NodeReasons selected={selected} />;
}

function NodeReasons({ selected }: { selected: Selected }) {
  const { plan, index, node } = selected;
  const setPanel = useSession((s) => s.setPanel);
  const model = useMemo(() => reasonsModel(plan, index, node), [plan, index, node]);
  if (!model) return <EmptyNote>Select a workflow, job or step to see why it runs.</EmptyNote>;
  return (
    <article
      aria-label={`Reasons for ${model.header.label}`}
      tabIndex={-1}
      className="flex flex-col gap-3 text-xs outline-none"
    >
      <Header header={model.header} />
      <section className="flex flex-col gap-1.5">
        <SectionTitle>Chain</SectionTitle>
        <ol aria-label="Reasons in evaluation order" className="flex flex-col gap-1">
          {model.rows.map((row) => (
            <ReasonRow key={row.index} row={row} index={index} />
          ))}
        </ol>
      </section>
      {model.diagnostics.length > 0 && <Diagnostics diagnostics={model.diagnostics} />}
      <button
        type="button"
        className="self-start rounded border border-border px-1.5 py-0.5 text-text hover:border-border-strong"
        onClick={() => {
          // The tab closes with the button in it: the focus follows to the Node tab's panel.
          setPanel('node');
          focusPanel('node');
        }}
      >
        Effects in the Node tab
      </button>
    </article>
  );
}

function Header({ header }: { header: ReasonsHeader }) {
  return (
    <header className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {/* The verdict word beside it names the mark. */}
        <span aria-hidden="true" className="flex">
          <Mark verdict={header.verdict} />
        </span>
        <h2 className="break-all font-medium text-sm">{header.label}</h2>
        <span className="text-muted">
          {MARK_LABEL[header.verdict]}
          {header.result !== undefined && ` · result ${header.result}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <CopyPath key={header.path} path={header.path} />
        {header.loc && <LocLink loc={header.loc} />}
      </div>
      {header.clause !== '' && <p className="break-words font-mono text-muted">{header.clause}</p>}
    </header>
  );
}

/** The unit path and a button that copies it; a refused clipboard selects the path instead. */
function CopyPath({ path }: { path: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'refused'>('idle');
  const code = useRef<HTMLElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async (): Promise<void> => {
    if (await copyText(path)) return setState('copied');
    if (code.current) window.getSelection()?.selectAllChildren(code.current);
    setState('refused');
  };

  return (
    <>
      <code ref={code} className="break-all font-mono">
        {path}
      </code>
      <button
        type="button"
        className="rounded px-1 text-muted underline decoration-dotted underline-offset-2 hover:text-text"
        onClick={() => void copy()}
      >
        Copy<span className="sr-only"> the unit path</span>
      </button>
      <span role="status" className="text-muted">
        {STATUS[state]}
      </span>
    </>
  );
}

const STATUS = { idle: '', copied: 'copied', refused: 'copy refused: the path is selected' } as const;

function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <SectionTitle>Diagnostics</SectionTitle>
      <ul className="flex flex-col gap-1">
        {diagnostics.map((d, i) => (
          <li key={`${d.code}-${i}`} className="break-words">
            <span className={d.severity === 'error' ? 'font-medium text-danger' : 'font-medium'}>
              {d.severity}
            </span>{' '}
            <code className="font-mono text-muted">{d.code}</code> {d.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
