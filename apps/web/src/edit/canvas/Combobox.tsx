import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

/**
 * A text input that filters a list the arrows walk and Enter picks: the WAI-ARIA combobox with a listbox popup (the
 * input keeps the focus; `aria-activedescendant` names the active option), its options grouped in sections when they
 * have one. What it needs and the palette use it. Base UI's Combobox would cost the edit runtime 33 kB gzipped.
 */

export interface ComboOption {
  key: string;
  label: string;
  /** A second line in muted text: counts, refs, what the entry writes. */
  detail?: string;
  /** The heading it is listed under; options of one section come together. */
  section?: string;
}

export function Combobox({
  label,
  query,
  onQuery,
  options,
  onPick,
  onBackspace,
  placeholder,
  empty,
  input,
  autoFocus,
}: {
  label: string;
  query: string;
  onQuery: (query: string) => void;
  options: readonly ComboOption[];
  onPick: (option: ComboOption) => void;
  /** Backspace in the empty input: What it needs takes the last need away. */
  onBackspace?: () => void;
  placeholder?: string;
  /** What the list says when nothing matches. */
  empty: ReactNode;
  input?: RefObject<HTMLInputElement | null>;
  /** The input takes the focus when its popover or dialog opens. */
  autoFocus?: boolean;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const at = options.length === 0 ? -1 : Math.min(active, options.length - 1);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [at]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const move = MOVES[e.key];
    if (move && options.length > 0) {
      e.preventDefault();
      setActive(move(at, options.length));
    } else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault();
      onPick(options[at]!);
    } else if (e.key === 'Backspace' && query === '' && onBackspace) {
      e.preventDefault();
      onBackspace();
    }
  };
  const optionId = (i: number): string => `${id}-option-${i}`;
  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={input}
        type="text"
        role="combobox"
        data-autofocus={autoFocus || undefined}
        aria-label={label}
        aria-expanded={options.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={at >= 0 ? optionId(at) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-text text-xs"
      />
      <div
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        className="flex max-h-72 flex-col overflow-y-auto"
      >
        {options.length === 0 ? (
          <p className="px-1.5 py-1 text-muted">{empty}</p>
        ) : (
          sections(options).map(({ title, items }) => (
            <Section key={title ?? ''} title={title} id={`${id}-${title ?? ''}`}>
              {items.map(({ option, index }) => (
                <div
                  key={option.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === at}
                  data-index={index}
                  className="flex cursor-pointer flex-col rounded px-1.5 py-1 aria-selected:bg-accent-soft"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => onPick(option)}
                >
                  <span className="truncate font-mono">{option.label}</span>
                  {option.detail && <span className="truncate text-muted">{option.detail}</span>}
                </div>
              ))}
            </Section>
          ))
        )}
      </div>
    </div>
  );
}

const MOVES: Record<string, (at: number, n: number) => number> = {
  ArrowDown: (at, n) => (at + 1) % n,
  ArrowUp: (at, n) => (at - 1 + n) % n,
  PageDown: (at, n) => Math.min(n - 1, at + 8),
  PageUp: (at) => Math.max(0, at - 8),
};

/** The options in their sections, in the order the sections first come; each keeps its index in the whole list. */
function sections(options: readonly ComboOption[]) {
  const out: { title?: string; items: { option: ComboOption; index: number }[] }[] = [];
  options.forEach((option, index) => {
    const last = out.at(-1);
    if (last && last.title === option.section) last.items.push({ option, index });
    else
      out.push({
        ...(option.section === undefined ? {} : { title: option.section }),
        items: [{ option, index }],
      });
  });
  return out;
}

function Section({ title, id, children }: { title?: string; id: string; children: ReactNode }) {
  if (title === undefined) return <>{children}</>;
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col pb-1">
      <div
        id={id}
        role="presentation"
        className="px-1.5 pt-1 pb-0.5 font-medium text-muted uppercase tracking-wide"
      >
        {title}
      </div>
      {children}
    </div>
  );
}
