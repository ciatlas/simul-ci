import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Check } from './model';

/**
 * The pieces of a trigger row: chips that × (or Delete) removes, the + that opens an inline input (Enter adds,
 * Escape cancels), and the check at the row's end. Removing a chip leaves the focus on the chip that took its place, or
 * on +, so the keyboard keeps its place in the row.
 */

const CHIP = 'inline-flex items-center gap-0.5 rounded border py-px pl-1.5 font-mono text-[11px]';
export const SMALL_BUTTON =
  'rounded px-1 text-muted text-xs hover:text-text focus-visible:outline-2 focus-visible:outline-accent';

export interface ChipListProps {
  /** The row's name, for the controls' accessible names: `push's branches`. */
  label: string;
  values: readonly string[];
  /** The values are defaults the file does not write: shown grey, with nothing to remove. */
  defaults?: boolean;
  /** What a new value is called: `branch pattern`, `type`, `option`. */
  noun: string;
  /** Values offered while typing one. */
  suggest?: readonly string[];
  locked: boolean;
  onRemove: (index: number) => void;
  /** Adds a value; false when the edit was refused, so what was typed stays to be fixed. */
  onAdd: (value: string) => boolean;
  /** The input opens at once (a filter just picked); closing it without a value calls this. */
  open?: boolean;
  onClose?: () => void;
}

export function ChipList(props: ChipListProps) {
  const { label, values, defaults = false, locked, onRemove } = props;
  const list = useRef<HTMLUListElement>(null);
  const [focusAt, setFocusAt] = useState<number>();
  // Before the editor's own fallback, which runs after its children's layout effects.
  useLayoutEffect(() => {
    if (focusAt === undefined) return;
    setFocusAt(undefined);
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(
      'button[data-remove], button[data-add]',
    );
    buttons?.[Math.min(focusAt, buttons.length - 1)]?.focus();
  }, [values, focusAt]);
  const remove = (index: number): void => {
    setFocusAt(index);
    onRemove(index);
  };
  return (
    <ul ref={list} aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1">
      {values.map((value, i) => (
        <li
          key={`${i}:${value}`}
          className={`${CHIP} ${defaults ? 'border-dashed border-border text-muted' : 'border-border'}`}
        >
          {value}
          {!defaults && !locked ? (
            <button
              type="button"
              data-remove
              className="rounded px-1 text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={`Remove ${value} from ${label}`}
              onClick={() => remove(i)}
              onKeyDown={(e) => {
                if (e.key !== 'Delete' && e.key !== 'Backspace') return;
                e.preventDefault();
                remove(i);
              }}
            >
              ×
            </button>
          ) : (
            <span className="pr-1.5" />
          )}
        </li>
      ))}
      {defaults && <li className="text-muted text-xs">(default)</li>}
      {!locked && (
        <li>
          <AddValue {...props} />
        </li>
      )}
    </ul>
  );
}

/** + and the inline input it opens: Enter adds the value and stays for another, Escape or an empty blur closes it. */
function AddValue({ label, noun, suggest = [], onAdd, open = false, onClose }: ChipListProps) {
  const [editing, setEditing] = useState(open);
  const [text, setText] = useState('');
  const plus = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const close = (refocus: boolean): void => {
    setEditing(false);
    setText('');
    onClose?.();
    if (refocus) requestAnimationFrame(() => plus.current?.focus());
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (text.trim() === '') return;
      if (onAdd(text.trim())) setText('');
    }
  };
  if (!editing)
    return (
      <button
        ref={plus}
        type="button"
        data-add
        className={SMALL_BUTTON}
        aria-label={`Add ${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun} to ${label}`}
        onClick={() => setEditing(true)}
      >
        +
      </button>
    );
  return (
    <>
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the + the author pressed is replaced by this input
        autoFocus
        className="w-28 rounded border border-border bg-surface px-1 py-px font-mono text-[11px] text-text"
        aria-label={`New ${noun} for ${label}`}
        value={text}
        spellCheck={false}
        list={suggest.length ? listId : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
        onBlur={() => {
          if (text.trim() === '') close(false);
        }}
      />
      {suggest.length > 0 && (
        <datalist id={listId}>
          {suggest.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}

const MARK = { yes: '✓', no: '✗', maybe: '?' } as const;
const COLOR = { yes: 'text-run', no: 'text-danger', maybe: 'text-might-text' } as const;

/** The plan's word on a row: ✓ or ✗ (? when the scenario leaves it open), "as of the last plan" while behind. */
export function CheckMark({ check, behind }: { check: Check | undefined; behind: boolean }) {
  if (!check) return null;
  return (
    <span className={`text-xs ${COLOR[check.mark]}`} data-check={check.mark}>
      <span aria-hidden="true">{MARK[check.mark]}</span> {check.text}
      {behind && <span className="text-muted"> (as of the last plan)</span>}
    </span>
  );
}

/** A row of the editor, for a column 320 px wide: its name with its check and its menu at the end, then what it holds. */
export function Row({ name, children, end }: { name: ReactNode; children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pl-5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-muted text-xs">{name}</span>
        {end && (
          <span className="ml-auto flex min-w-0 flex-wrap items-baseline justify-end gap-x-1">{end}</span>
        )}
      </div>
      <div className="min-w-0 pl-2">{children}</div>
    </div>
  );
}
