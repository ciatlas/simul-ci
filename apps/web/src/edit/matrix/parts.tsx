import { type RefObject, useEffect, useRef } from 'react';
import { LineLink } from '../property/Field';
import type { Fixed } from './model';

/** What every part of the matrix editor is about. */
export interface MatrixContext {
  file: string;
  job: string;
  /** The file's revision the panel was drawn from: a click on what it shows refuses `stale` once the text moved. */
  rev: number;
  /** The file is locked: the editor shows the matrix and takes no input. */
  locked: boolean;
}

export const CHIP =
  'inline-flex max-w-full items-center gap-0.5 rounded border border-border bg-surface px-1 font-mono text-xs';
export const SMALL_INPUT =
  'min-w-0 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-text hover:border-border-strong aria-invalid:border-danger';
export const ADD_BUTTON =
  'self-start rounded border border-border border-dashed px-2 py-0.5 text-muted text-xs hover:bg-chrome hover:text-text';

/** A small × that removes what it names. */
export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded px-1 text-muted leading-none hover:text-text"
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}

/** A part the editor cannot write in place: its source, why ("Set at run time"), and a link to its line. */
export function FixedPart({ label, fixed, file }: { label: string; fixed: Fixed; file: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-fixed={label}>
      <span className="font-mono text-xs">{label}</span>
      <pre className="overflow-x-auto rounded border border-border border-dashed bg-chrome px-2 py-1 font-mono text-xs">
        {fixed.source}
      </pre>
      <p className="text-muted text-xs">
        {fixed.why}; <LineLink file={file} line={fixed.line} label="edit in YAML" />
      </p>
    </div>
  );
}

/** An input that takes the focus as it appears: the one a + button opened. */
export function useFocusOnMount<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}
