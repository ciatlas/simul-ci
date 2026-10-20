import type { NodeId } from '@simulci/engine';
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApp, useSession } from '../app/providers';
import { gestures } from '../edit/gestures';
import { MARK_LABEL, Mark } from '../graph/Mark';
import { planIndex, resolveSelection, selectionOf } from '../plan/index';
import type { PlanState } from '../state/store';
import {
  openedFor,
  outlineModel,
  planLabels,
  tabStop,
  toggled,
  type TreeMove,
  type TreeRow,
  treeKey,
  visibleRows,
} from './outline-tree';

/**
 * The plan as a tree (synthesis § 11): the accessible baseline of the canvas, with the same selection. One tab stop
 * (a roving tabindex), the WAI-ARIA tree keys, Enter or a click selects. A selection made elsewhere opens its
 * ancestors and takes the tab stop, but focus stays where the author left it. In edit mode a row's actions (add a job,
 * what it needs, a step, remove, move) open in a menu at it: the context menu key, Shift+F10 or a right click.
 */
export function OutlineTree() {
  const plan = useSession((s) => s.plan);
  return plan ? <PlanTree plan={plan} /> : null;
}

function PlanTree({ plan }: { plan: PlanState }) {
  const { store } = useApp();
  const focus = useSession((s) => s.focus);
  const sel = useSession((s) => s.sel);
  const hide = useSession((s) => s.ui.hideUntriggered);
  const index = planIndex(plan);
  const model = useMemo(() => outlineModel(index, planLabels(plan.plan)), [index, plan]);
  const selected = resolveSelection(index, focus, sel);
  const [open, setOpen] = useState(() => openedFor(new Set<NodeId>(), model, selected));
  const [active, setActive] = useState<NodeId>();
  const tree = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<NodeId, HTMLElement>());
  const heading = useId();

  useEffect(() => {
    setOpen((o) => openedFor(o, model, selected));
    if (!tree.current?.contains(document.activeElement)) setActive(undefined);
  }, [model, selected]);

  const rows = visibleRows(model, open, hide);
  const stop = tabStop(rows, active, selected);

  const choose = (id: NodeId): void => {
    setActive(id);
    const next = selectionOf(index, id);
    store.getState().select(next.focus, next.sel);
  };
  const apply = (move: TreeMove): void => {
    if ('select' in move) return choose(move.select);
    if ('focus' in move) {
      setActive(move.focus);
      items.current.get(move.focus)?.focus();
      return;
    }
    setOpen((o) => toggled(o, 'open' in move ? move.open : move.close));
  };
  const actions = (id: NodeId, at: HTMLElement | undefined): boolean =>
    at !== undefined && store.getState().edit.on && (gestures.of(store)?.menu(id, at) ?? false);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const menu = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
    if (menu && stop !== undefined && actions(stop, items.current.get(stop))) {
      e.preventDefault();
      return;
    }
    const move = treeKey(e, stop, rows);
    if (!move) return;
    e.preventDefault();
    apply(move);
  };

  return (
    <section className="flex flex-col gap-1">
      <h2 id={heading} className="font-medium text-muted text-xs">
        Outline
      </h2>
      <div ref={tree} role="tree" aria-labelledby={heading} onKeyDown={onKeyDown} className="text-xs">
        {rows.map((row) => (
          <Item
            key={row.node.id}
            row={row}
            selected={row.node.id === selected}
            tabbable={row.node.id === stop}
            register={(el) => {
              if (el) items.current.set(row.node.id, el);
              else items.current.delete(row.node.id);
            }}
            onChoose={() => choose(row.node.id)}
            onToggle={() => setOpen((o) => toggled(o, row.node.id))}
            onMenu={(el) => {
              setActive(row.node.id);
              return actions(row.node.id, el);
            }}
          />
        ))}
      </div>
    </section>
  );
}

const ROW =
  'flex cursor-default items-center gap-1.5 border-transparent border-l-2 py-0.5 pr-2 hover:bg-surface ' +
  'aria-selected:border-accent aria-selected:bg-accent-soft';

interface ItemProps {
  row: TreeRow;
  selected: boolean;
  tabbable: boolean;
  register: (el: HTMLElement | null) => void;
  onChoose: () => void;
  onToggle: () => void;
  /** Opens the row's actions in edit mode: true when they opened. */
  onMenu: (el: HTMLElement) => boolean;
}

function Item({ row, selected, tabbable, register, onChoose, onToggle, onMenu }: ItemProps) {
  const { node } = row;
  return (
    <div
      ref={register}
      role="treeitem"
      aria-label={`${node.label}, ${MARK_LABEL[node.verdict]}`}
      aria-level={row.level}
      aria-posinset={row.posinset}
      aria-setsize={row.setsize}
      aria-expanded={row.expanded}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      onClick={onChoose}
      onContextMenu={(e) => {
        if (onMenu(e.currentTarget)) e.preventDefault();
      }}
      className={`${ROW} ${node.verdict === 'no' ? 'text-muted' : 'text-text'}`}
      style={{ paddingLeft: `${(row.level - 1) * 12 + 2}px` }}
    >
      <Disclosure expanded={row.expanded} onToggle={onToggle} />
      <Mark verdict={node.verdict} />
      <span className="truncate">{node.label}</span>
    </div>
  );
}

/** The pointer's way to open a row; the keys open it with → and ←, so it is hidden from the accessibility tree. */
function Disclosure({ expanded, onToggle }: { expanded: boolean | undefined; onToggle: () => void }) {
  if (expanded === undefined) return <span aria-hidden="true" className="w-3 shrink-0" />;
  const onClick = (e: MouseEvent): void => {
    e.stopPropagation();
    onToggle();
  };
  return (
    <span
      aria-hidden="true"
      data-disclosure=""
      className="w-3 shrink-0 text-center text-muted"
      onClick={onClick}
    >
      {expanded ? '▾' : '▸'}
    </span>
  );
}
