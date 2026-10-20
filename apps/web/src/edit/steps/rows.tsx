import { type DragEvent, type MouseEvent, useState } from 'react';

/**
 * What the two editable step lists share (synthesis § 4.2, § 4.5): a step's row is dragged by its handle and dropped
 * on another row to take its place, and + between two rows opens the palette for a step there. The keyboard's way is
 * Alt+↑/↓ and `s`; the handles and the +s are the pointer's and no tab stops.
 */

const TYPE = 'application/x-simulci-step';

/** A drag of one row's handle: the row it came from and the row it is over. */
export function useStepDrag(move: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<{ from: number; over?: number }>();
  const handle = (index: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent): void => {
      e.stopPropagation();
      e.dataTransfer.setData(TYPE, String(index));
      e.dataTransfer.effectAllowed = 'move';
      setDrag({ from: index });
    },
    onDragEnd: (): void => setDrag(undefined),
  });
  const target = (index: number) => ({
    onDragOver: (e: DragEvent): void => {
      if (!drag || !e.dataTransfer.types.includes(TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (drag.over !== index) setDrag({ ...drag, over: index });
    },
    onDrop: (e: DragEvent): void => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      if (drag.from !== index) move(drag.from, index);
      setDrag(undefined);
    },
    'data-drop':
      drag?.over === index && drag.from !== index ? (drag.from < index ? 'after' : 'before') : undefined,
  });
  return { handle, target };
}

/** The handle a row is dragged by: seen under the pointer, hidden from the accessibility tree. */
export function DragHandle(props: ReturnType<ReturnType<typeof useStepDrag>['handle']>) {
  return (
    <span {...props} aria-hidden="true" className="sc-step-handle nodrag nopan" title="Drag to move">
      ⠿
    </span>
  );
}

/** + at the top edge of a row (the bottom edge of the last, `after`): a step goes there. */
export function InsertGap({
  label,
  onInsert,
  after,
}: {
  label: string;
  onInsert: () => void;
  after?: boolean;
}) {
  const click = (e: MouseEvent): void => {
    e.stopPropagation();
    onInsert();
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      className="sc-step-gap nodrag nopan"
      data-after={after || undefined}
      aria-label={label}
      title={label}
      onClick={click}
    >
      +
    </button>
  );
}
