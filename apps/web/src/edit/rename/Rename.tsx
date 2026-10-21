import { type FormEvent, useCallback, useId, useRef, useState } from 'react';
import type { App } from '../../app/boot';
import { useApp } from '../../app/providers';
import { fileLabel } from '../../lib/file-label';
import { AnchoredPopover } from '../canvas/Popover';
import type { GestureUi, Open } from '../canvas/ui';
import { documents } from '../documents';
import { RefusalNote } from '../Refusal';
import { renameProblem, startingId, summaryOf, takenIds } from './form';
import {
  dispatchRename,
  findRefs,
  type Found,
  fresh,
  oldId,
  type Preview,
  preview,
  type RenameTarget,
} from './run';

const INPUT = 'w-full rounded border border-accent bg-bg px-1.5 py-0.5 font-mono text-text text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs hover:bg-chrome';

/** What the newest lookup found for an id, ready to review. */
interface Ready {
  to: string;
  found: Found;
  preview: Preview;
  /** Why the list was made again before renaming. */
  note?: string;
  n: number;
}

/**
 * Rename (synthesis § 4.2): F2, a double-click on a card's title, or the outline row's menu opens an input over the
 * title holding the id, selected so typing replaces it. Enter looks up where the id is written in the newest texts and
 * opens, under the input, the list of every line the rename changes, what it leaves (route tests that name the old id,
 * reads it cannot follow) and Rename, which has the focus: Enter renames, Escape goes back to the input. A text that
 * changed since the list was made is listed again before anything is written.
 */
export function RenamePopover({
  open,
  ui,
  onClose,
}: {
  open: Extract<Open, { kind: 'rename' }>;
  ui: GestureUi;
  onClose: () => void;
}) {
  const app = useApp();
  const { store } = app;
  const { target } = open;
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [taken] = useState(() => takenIds(documents(store).of(store.getState(), target.file), target));
  const [to, setTo] = useState(() => startingId(target, taken));
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const { lookup, look, forget } = useLookup(app, target);
  const old = oldId(target);
  const id = to.trim();
  const problem = renameProblem(target, id, taken);
  const what = target.step ? `the id of step ${target.step.index + 1} of ${target.job}` : `job ${target.job}`;
  const hint = hintOf(problem, lookup, old);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (problem) return;
    if (id === old) return onClose();
    setRefusedSeq(undefined);
    look(id);
  };
  const rename = async (r: Ready): Promise<void> => {
    if (!fresh(store.getState(), r.found, target.file))
      return look(r.to, `${fileLabel(target.file)} changed since; this is what the rename changes now.`);
    const result = await dispatchRename(app, target, r.to, r.found);
    if (!result.ok) return setRefusedSeq(result.refused.seq);
    if (result.changed && !target.step) ui.added(`${target.file}#${r.to}`, store.getState().files.version);
    onClose();
  };
  const back = (): void => {
    forget();
    input.current?.focus();
  };

  return (
    <AnchoredPopover
      anchor={open.anchor}
      side="over"
      label={`Rename ${what}`}
      onClose={onClose}
      frame="border border-border bg-surface p-1.5"
      className="w-64"
    >
      <form onSubmit={submit}>
        <input
          ref={input}
          data-autofocus
          className={INPUT}
          aria-label={`New id for ${what}`}
          value={to}
          spellCheck={false}
          aria-invalid={problem !== undefined}
          aria-describedby={`${ids}-say`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            forget();
            setTo(e.target.value);
          }}
        />
        <p id={`${ids}-say`} className={`mt-1 ${hint.danger ? 'text-danger' : 'text-muted'}`}>
          {hint.text}
        </p>
      </form>
      {lookup.status === 'ready' && (
        <Review
          key={lookup.n}
          anchor={input.current ?? undefined}
          title={`Rename ${old ?? what} to ${lookup.to}`}
          ready={lookup}
          target={target}
          refusedSeq={refusedSeq}
          onRename={() => void rename(lookup)}
          onClose={back}
        />
      )}
    </AnchoredPopover>
  );
}

/** Where the rename stands: nothing asked, looking, nothing found and why, or what it would write. */
type Lookup =
  | { status: 'idle' }
  | { status: 'finding' }
  | { status: 'failed'; message: string }
  | ({ status: 'ready' } & Ready);

/**
 * The lookup of an id's references and the list the rename would write. Only the newest answers: an id typed over,
 * or the list closed, drops the one on its way.
 */
function useLookup(app: Pick<App, 'store' | 'session'>, target: RenameTarget) {
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const asked = useRef(0);
  const look = useCallback(
    (to: string, note?: string): void => {
      const n = ++asked.current;
      setLookup({ status: 'finding' });
      // References found for a text that moved before they came are looked up once more.
      const run = (again: boolean): void =>
        void findRefs(app.session, app.store, target).then((found) => {
          if (asked.current !== n) return;
          if (!found.ok) return setLookup({ status: 'failed', message: found.message });
          if (again && !fresh(app.store.getState(), found, target.file)) return run(false);
          const p = preview(app.store, target, to, found);
          setLookup({ status: 'ready', to, found, preview: p, n, ...(note === undefined ? {} : { note }) });
        });
      run(true);
    },
    [app, target],
  );
  const forget = useCallback((): void => {
    asked.current++;
    setLookup({ status: 'idle' });
  }, []);
  return { lookup, look, forget };
}

/** What the line under the input says: why the id cannot be one, why nothing was found, or what to do. */
function hintOf(problem: string | undefined, lookup: Lookup, old: string | undefined) {
  if (problem !== undefined) return { text: problem, danger: true };
  if (lookup.status === 'failed') return { text: lookup.message, danger: true };
  if (lookup.status === 'finding') return { text: `Finding where ${old ?? 'it'} is used…`, danger: false };
  return { text: 'Enter to review, Escape to cancel', danger: false };
}

/** The list of what the rename changes, under the input, with Rename focused. */
function Review({
  anchor,
  title,
  ready,
  target,
  refusedSeq,
  onRename,
  onClose,
}: {
  anchor: Element | undefined;
  title: string;
  ready: Ready;
  target: Extract<Open, { kind: 'rename' }>['target'];
  refusedSeq: number | undefined;
  onRename: () => void;
  onClose: () => void;
}) {
  const p = ready.preview;
  const left = p.ok ? [...p.warnings.map((w) => w.message), ...p.notes] : [];
  return (
    <AnchoredPopover anchor={anchor} side="below" label={title} onClose={onClose} className="w-[28rem]">
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold text-sm">{title}</h2>
        {ready.note && <p className="text-muted">{ready.note}</p>}
        {p.ok ? (
          <>
            <p>{summaryOf(target, p)}</p>
            <ol className="max-h-48 overflow-y-auto rounded border border-border bg-bg py-1 font-mono">
              {p.lines.map(({ line, text }) => (
                <li key={line} className="flex gap-2 px-2">
                  <span className="w-8 shrink-0 text-right text-muted">{line}</span>
                  <span className="truncate whitespace-pre">{text.trim()}</span>
                </li>
              ))}
            </ol>
            {left.length > 0 && (
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {left.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-danger">{p.refusal.message}</p>
        )}
        <RefusalNote seq={refusedSeq} />
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} data-autofocus={p.ok ? undefined : true} onClick={onClose}>
            {p.ok ? 'Cancel' : 'Back'}
          </button>
          {p.ok && (
            <button
              type="button"
              data-autofocus
              className={`${BUTTON} border-accent bg-accent text-on-accent hover:bg-accent`}
              onClick={onRename}
            >
              Rename
            </button>
          )}
        </div>
      </div>
    </AnchoredPopover>
  );
}
