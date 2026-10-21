import { type Fp, planOp, type Warning, type WorkflowOp } from '@simulci/document';
import type { NodeId } from '@simulci/engine';
import type { SessionStore } from '../../state/store';
import { dispatch, storeLock } from '../dispatch';
import { documents } from '../documents';
import type { OpMeta } from '../types';

/**
 * What a structural gesture shows and how a removal goes (synthesis § 4.2): the edit host's popovers and questions as
 * an interface the gestures call, and the removal that asks first when it warns or takes more with it, then leaves a
 * notice that offers Undo.
 */

const hosts = new WeakMap<SessionStore, GestureUi>();

/** The edit host's UI, which it registers while it shows: Properties' step rows ask and remove through it too. */
export const hostUi = {
  register(store: SessionStore, ui: GestureUi): () => void {
    hosts.set(store, ui);
    return () => {
      if (hosts.get(store) === ui) hosts.delete(store);
    };
  },
  of: (store: SessionStore): GestureUi | undefined => hosts.get(store),
};

/** What the edit host shows for a gesture: a popover at a card or a row, a confirmation, a refusal at a card. */
export interface GestureUi {
  open(open: Open): void;
  confirm(ask: Ask): void;
  /** A refused gesture made on the canvas: its sentence at the card, as well as in the status line. */
  refused(seq: number, anchor?: Element): void;
  /** A job was added: its card takes the focus once a picture draws it. */
  added(card: NodeId, files: number): void;
}

export type Open =
  | { kind: 'addJob'; file: string; rev: number; after?: string; anchor?: Element }
  | { kind: 'needs'; file: string; rev: number; job: string; anchor?: Element }
  | { kind: 'menu'; node: NodeId; anchor: Element }
  | PaletteOpen;

/** The palette (`edit/palette/Palette.tsx`), for a step to add at a place in a job, or for one whose action changes. */
export interface PaletteOpen {
  kind: 'palette';
  file: string;
  rev: number;
  job: string;
  /** Where the step goes, or the step whose action changes. */
  index: number;
  /** The step changed, as the author saw it. */
  change?: Fp;
}

/** A question before an op: what it takes with it, and the button that runs it. */
export interface Ask {
  title: string;
  lines: string[];
  action: string;
  run: () => void;
}

interface Removal {
  op: WorkflowOp;
  meta: OpMeta & { label: string };
  toast: string;
  ask: Omit<Ask, 'run'>;
  anchor?: Element | undefined;
  /** Ask even without a warning: the removal takes more than the author pointed at. */
  always?: boolean;
}

/**
 * A removal: planned once to read its warnings, asked about when it warns (a need its reader loses, a step id still
 * read) or takes more with it, then dispatched with the revision the gesture read, so a text that moved while the
 * question was open refuses `stale`. The notice it leaves offers Undo while its entry is the newest.
 */
export function removal(store: SessionStore, ui: GestureUi, r: Removal): void {
  const run = (): void => {
    const result = dispatch(store, r.op, r.meta);
    if (!result.ok) {
      ui.refused(result.refused.seq, r.anchor);
      return;
    }
    if (!result.changed) return;
    const s = store.getState();
    s.notify(r.toast, s.edit.past.at(-1));
  };
  const warnings = warningsOf(store, r.op).filter((w) => w.code !== 'callers');
  if (warnings.length === 0 && !r.always) return run();
  ui.confirm({ ...r.ask, lines: [...r.ask.lines, ...warnings.map((w) => w.message)], run });
}

/** What an op would warn of on the text now, planned and not committed; none when it would be refused. */
export function warningsOf(store: SessionStore, op: WorkflowOp): Warning[] {
  const s = store.getState();
  if (storeLock(s, op.file)) return [];
  const docs = documents(store);
  const plan = planOp(op, { doc: (path) => docs.of(s, path) });
  return plan.ok ? plan.warnings : [];
}
