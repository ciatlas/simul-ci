import type { NodeId } from '@simulci/engine';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useSession } from '../../app/providers';
import { viewport } from '../../graph/commands';
import { gestures } from '../gestures';
import { RefusalNote } from '../Refusal';
import { type Ask, cardElement, type GestureUi, gesturesOf, type Open } from './actions';
import { AddJobPopover } from './AddJob';
import { ConfirmDialog } from './Confirm';
import { RowMenu } from './Menu';
import { NeedsPopover } from './Needs';
import { AnchoredPopover } from './Popover';

/**
 * The structural gestures' host while edit mode shows (synthesis § 4.2, § 4.5): it registers what the canvas, the
 * page keys and the outline tree ask for (`edit/gestures.ts`), and shows what they open: Add job, What it needs, an
 * outline row's actions, the question before a removal, and a refused canvas gesture's sentence at its card. A job
 * added takes the focus once its card is drawn, brought into view when it is outside it.
 */
export function EditHost() {
  const { store } = useApp();
  // Each opening is a fresh popover, its fields read anew, even of the same kind.
  const [shown, setShown] = useState<{ open: Open; n: number }>();
  const open = shown?.open;
  // Each question is a dialog of its own: one closing settles only itself, never the one asked after it.
  const [ask, setAsk] = useState<{ ask: Ask; n: number }>();
  const [note, setNote] = useState<{ seq: number; anchor?: Element }>();
  const [added, setAdded] = useState<{ card: NodeId; files: number }>();
  const ui = useMemo<GestureUi>(
    () => ({
      open: (next) => setShown((was) => ({ open: next, n: (was?.n ?? 0) + 1 })),
      confirm: (next) => setAsk((was) => ({ ask: next, n: (was?.n ?? 0) + 1 })),
      refused: (seq, anchor) => setNote(anchor ? { seq, anchor } : { seq }),
      added: (card, files) => setAdded({ card, files }),
    }),
    [],
  );
  useEffect(() => gestures.register(store, gesturesOf(store, ui)), [store, ui]);
  const close = useCallback(() => setShown(undefined), []);
  const closeAsk = useCallback((n: number) => setAsk((was) => (was?.n === n ? undefined : was)), []);
  const closeNote = useCallback(() => setNote(undefined), []);
  const focused = useCallback(() => setAdded(undefined), []);
  useFocusAdded(added, focused);
  return (
    <>
      {/* Siblings: each key names its slot too, so a question and a note of the same number are never one child. */}
      {open && <Opened key={`open-${shown.n}`} open={open} ui={ui} onClose={close} />}
      {ask && <ConfirmDialog key={`ask-${ask.n}`} ask={ask.ask} n={ask.n} onClose={closeAsk} />}
      {note && (
        <CardNote key={`note-${note.seq}`} seq={note.seq} anchor={note.anchor} onClose={closeNote} />
      )}
    </>
  );
}

/** What a gesture opened. */
function Opened({ open, ui, onClose }: { open: Open; ui: GestureUi; onClose: () => void }) {
  if (open.kind === 'addJob') return <AddJobPopover open={open} ui={ui} onClose={onClose} />;
  if (open.kind === 'needs') return <NeedsPopover open={open} ui={ui} onClose={onClose} />;
  return <RowMenu node={open.node} anchor={open.anchor} onClose={onClose} />;
}

/**
 * A refused canvas gesture's sentence and fixes under its card, while that refusal is the store's. It shows a frame
 * after the gesture: a drag ends on pointerup, whose light dismiss would close a popover shown in it at once.
 */
function CardNote({ seq, anchor, onClose }: { seq: number; anchor?: Element; onClose: () => void }) {
  const live = useSession((s) => s.edit.refused?.seq === seq);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!live) onClose();
  }, [live, onClose]);
  if (!live || !anchor || !settled) return null;
  return (
    <AnchoredPopover
      anchor={anchor}
      side="below"
      label="Refused"
      role="note"
      onClose={onClose}
      className="w-72 border-0 p-0"
    >
      <RefusalNote seq={seq} />
    </AnchoredPopover>
  );
}

/**
 * The job just added: once a picture draws its card, the card comes into view if it is outside it and takes the focus
 * when the focus was on the canvas or nowhere, so the keys go on from it.
 */
function useFocusAdded(added: { card: NodeId; files: number } | undefined, done: () => void): void {
  const graph = useSession((s) => s.graph);
  useEffect(() => {
    if (!added || !graph || graph.for.files < added.files) return undefined;
    if (!graph.model.jobs[added.card]) return done();
    const frame = requestAnimationFrame(() => {
      viewport.centre(added.card);
      const active = document.activeElement;
      const card = cardElement(added.card);
      if (card instanceof HTMLElement && (active === document.body || active?.closest('.react-flow')))
        card.focus({ preventScroll: true });
      done();
    });
    return () => cancelAnimationFrame(frame);
  }, [added, graph, done]);
}
