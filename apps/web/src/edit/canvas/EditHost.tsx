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
  const [ask, setAsk] = useState<Ask>();
  const [note, setNote] = useState<{ seq: number; anchor?: Element }>();
  const [added, setAdded] = useState<{ card: NodeId; files: number }>();
  const ui = useMemo<GestureUi>(
    () => ({
      open: (next) => setShown((was) => ({ open: next, n: (was?.n ?? 0) + 1 })),
      confirm: setAsk,
      refused: (seq, anchor) => setNote(anchor ? { seq, anchor } : { seq }),
      added: (card, files) => setAdded({ card, files }),
    }),
    [],
  );
  useEffect(() => gestures.register(store, gesturesOf(store, ui)), [store, ui]);
  const close = useCallback(() => setShown(undefined), []);
  const closeAsk = useCallback(() => setAsk(undefined), []);
  const closeNote = useCallback(() => setNote(undefined), []);
  const focused = useCallback(() => setAdded(undefined), []);
  useFocusAdded(added, focused);
  return (
    <>
      {open?.kind === 'addJob' && <AddJobPopover key={shown?.n} open={open} ui={ui} onClose={close} />}
      {open?.kind === 'needs' && <NeedsPopover key={shown?.n} open={open} ui={ui} onClose={close} />}
      {open?.kind === 'menu' && (
        <RowMenu key={shown?.n} node={open.node} anchor={open.anchor} onClose={close} />
      )}
      {ask && <ConfirmDialog ask={ask} onClose={closeAsk} />}
      {note && <CardNote seq={note.seq} anchor={note.anchor} onClose={closeNote} />}
    </>
  );
}

/** A refused canvas gesture's sentence and fixes under its card, while that refusal is the store's. */
function CardNote({ seq, anchor, onClose }: { seq: number; anchor?: Element; onClose: () => void }) {
  const live = useSession((s) => s.edit.refused?.seq === seq);
  useEffect(() => {
    if (!live) onClose();
  }, [live, onClose]);
  if (!live || !anchor) return null;
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
