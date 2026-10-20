import { fingerprint, type Json, planOp, type WorkflowDocument } from '@simulci/document';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useApp } from '../../app/providers';
import { control, monoControl } from '../../scenario/fields/kit';
import { documents } from '../documents';
import { RefusalNote, RefusalView } from '../Refusal';
import type { Refused } from '../types';
import { type FieldSpec, groupKey, type Shown, shown, valueOf } from './model';
import { fieldSession, type SessionTarget } from './session';

/**
 * One field of Properties (synthesis § 4.4). It shows the value the file writes, with a link to its line, and commits
 * what the author types on Enter (Mod+Enter in a multi-line field), when it loses the focus, and for a condition after
 * a short pause: every commit of one visit to the field is one undo entry. A value the field cannot write in place (an
 * alias, a merge key, a shape it cannot show) is shown as its source, read-only, with why and the fixes the edit's own
 * refusal offers. A refused commit shows its sentence and fixes under the field.
 */

export interface FieldProps {
  spec: FieldSpec;
  target: SessionTarget;
  doc: WorkflowDocument;
  /** The file is locked (generated, broken YAML, …): the field shows its value and takes no input. */
  locked?: boolean;
  /** Milliseconds of quiet after which the field commits while the author is still in it. */
  idle?: number;
  /** A request to take the focus (the `i` key); `done` acknowledges it. */
  request?: { seq: number; done: () => void };
  /** Values to offer as the author types (the runner labels the repository uses). */
  options?: readonly string[];
  /** What the field's value evaluates to on the plan: under the field. */
  after?: ReactNode;
}

export function Field(props: FieldProps) {
  const value = shown(props.doc, props.spec);
  return value.fixed ? <Fixed {...props} value={value} /> : <Editable {...props} value={value} />;
}

const LABEL = 'text-muted text-xs';

function Editable(props: FieldProps & { value: Shown }) {
  const { spec, target, options, after, value } = props;
  const id = useId();
  const { draft, input, refusedSeq, handlers } = useEditing(props);
  const list = options?.length ? `${id}-options` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-field={spec.key}>
      <Label htmlFor={id} spec={spec} target={target} line={value.line} />
      {spec.kind === 'lines' ? (
        <textarea
          ref={input}
          id={id}
          wrap="off"
          rows={Math.min(8, Math.max(3, (draft ?? value.text).split('\n').length))}
          {...handlers}
        />
      ) : (
        <input ref={input} id={id} type="text" list={list} spellCheck={false} {...handlers} />
      )}
      {list && (
        <datalist id={list}>
          {options!.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
      {after}
      <RefusalNote seq={refusedSeq} />
    </div>
  );
}

/**
 * A field's text while the author is in it, and its commits: the visit's session, the text typed since the last
 * commit, the refusal of the last commit, and the input's handlers.
 */
function useEditing({ spec, target, doc, locked, idle, request, value }: FieldProps & { value: Shown }) {
  const { store } = useApp();
  // One session per field of one node: the specs are rebuilt on every render, their keys stay.
  const group = groupKey(target.file, spec.path);
  const step = target.step && `${target.step.job}#${target.step.index}`;
  const session = useMemo(() => fieldSession(store, target, group), [store, group, step]);
  const [draft, setDraft] = useState<string>();
  const typed = useRef<string>(undefined);
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const commit = (): void => {
    const text = typed.current;
    if (text === undefined) return;
    const current: Json | undefined = doc.get(spec.path)?.value;
    const result = session.commit(text, (fp) => spec.op(valueOf(spec.kind, text, current), fp));
    if (result) setRefusedSeq(result.ok ? undefined : result.refused.seq);
  };
  const edit = (text: string | undefined): void => {
    typed.current = text;
    setDraft(text);
  };
  useIdle(idle, draft, commit);
  useFocusRequest(request, input);
  const handlers = {
    value: draft ?? value.text,
    readOnly: locked,
    placeholder: spec.placeholder,
    className: spec.kind === 'text' ? control : monoControl,
    onFocus: () => {
      if (locked) return;
      session.begin(value.text);
      edit(value.text);
    },
    onChange: (event: { target: { value: string } }) => edit(event.target.value),
    onKeyDown: (event: KeyboardEvent) =>
      onKey(event, spec.kind === 'lines', commit, () => {
        if (draft === undefined || draft === value.text) return false;
        edit(value.text);
        return true;
      }),
    onBlur: () => {
      commit();
      session.end();
      edit(undefined);
    },
  };
  return { draft, input, refusedSeq, handlers };
}

/**
 * Enter commits (Mod+Enter in a multi-line field, where Enter breaks the line); Escape drops the text typed since
 * the last commit, and a second Escape, with nothing to drop, goes on to the panel.
 */
function onKey(event: KeyboardEvent, multiline: boolean, commit: () => void, revert: () => boolean): void {
  if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    commit();
  } else if (event.key === 'Escape' && revert()) event.stopPropagation();
}

/** Commits once the author has paused for `idle` milliseconds in the field (Run if). */
function useIdle(idle: number | undefined, draft: string | undefined, commit: () => void): void {
  useEffect(() => {
    if (!idle || draft === undefined) return undefined;
    const timer = setTimeout(commit, idle);
    return () => clearTimeout(timer);
  }, [draft, idle]);
}

/** Takes the focus, its text selected, when the `i` key asks for it. */
function useFocusRequest(request: FieldProps['request'], input: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    if (!request) return;
    input.current?.focus();
    input.current?.select();
    request.done();
  }, [request?.seq]);
}

/** The field's label, and the line its value is on: a link that shows it in the YAML pane. */
function Label({
  htmlFor,
  spec,
  target,
  line,
}: {
  htmlFor?: string;
  spec: FieldSpec;
  target: SessionTarget;
  line?: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={LABEL}>
          {spec.label}
        </label>
      ) : (
        <span className={LABEL}>{spec.label}</span>
      )}
      {line !== undefined && <LineLink file={target.file} line={line} />}
    </div>
  );
}

/** `line 12`: shows the line in the YAML pane, editable. */
export function LineLink({
  file,
  line,
  label = `line ${line}`,
}: {
  file: string;
  line: number;
  label?: string;
}) {
  const { store } = useApp();
  return (
    <button
      type="button"
      className="rounded px-1 font-mono text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text"
      onClick={() => {
        const s = store.getState();
        s.setEdit(true);
        s.revealLine({ file, line });
      }}
    >
      {label}
      <span className="sr-only"> in the YAML pane</span>
    </button>
  );
}

/**
 * A value the field cannot write: its source, read-only, and why. For an alias or a merge key the why is the
 * refusal the edit itself would get, planned once for the text shown, with its fixes (Give deploy its own value).
 */
function Fixed({ spec, target, doc, value }: FieldProps & { value: Shown }) {
  const { store } = useApp();
  const refused = useMemo((): Refused | undefined => {
    if (!value.fixed?.probe) return undefined;
    const s = store.getState();
    const docs = documents(store);
    const fp = target.step && fingerprint(doc, target.step.job, target.step.index);
    const op = spec.op(doc.get(spec.path)?.value ?? null, fp);
    const plan = planOp(op, { doc: (path) => docs.of(s, path) });
    if (plan.ok) return undefined;
    const rev = s.files.revs[target.file];
    return {
      seq: 0,
      refusal: plan,
      ops: [{ op }],
      at: 0,
      meta: { origin: 'field', ...(rev === undefined ? {} : { revs: { [target.file]: rev } }) },
    };
  }, [store, doc, spec, target, value.fixed]);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-field={spec.key}>
      <Label spec={spec} target={target} line={value.line} />
      <pre className="overflow-x-auto rounded border border-border border-dashed bg-chrome px-2 py-1 font-mono text-xs">
        {value.fixed!.source}
      </pre>
      <div className="flex flex-col gap-1.5 rounded border border-might bg-might-soft px-2 py-1.5 text-xs">
        {refused ? (
          <RefusalView refused={refused} dismiss={false} />
        ) : (
          <>
            <p>{value.fixed!.why ?? `${spec.label} cannot be edited here.`}</p>
            {value.line !== undefined && (
              <LineLink file={target.file} line={value.line} label="Edit in YAML" />
            )}
          </>
        )}
      </div>
    </div>
  );
}
