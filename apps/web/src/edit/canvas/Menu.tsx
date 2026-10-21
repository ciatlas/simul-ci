import type { NodeId } from '@simulci/engine';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { useApp } from '../../app/providers';
import { planIndex } from '../../plan/index';
import type { SessionStore } from '../../state/store';
import { type Gestures, gestures } from '../gestures';
import { AnchoredPopover } from './Popover';

/**
 * An outline row's actions in edit mode (synthesis § 4.2: the outline tree stays the accessible baseline, every canvas
 * gesture a context action there): the context menu key, Shift+F10 or a right click opens it at the row, which is
 * selected first, so each action does what its key does on the canvas. ↑ and ↓ walk it, Enter takes an action, Escape
 * closes it and gives the focus back to the row.
 */

interface MenuItem {
  label: string;
  /** The key that does the same where the canvas has the focus. */
  keys?: string;
  run: (g: Gestures) => boolean;
}

/** The actions of a node of the focused workflow: the workflow's, a job's, a step's. */
function menuItems(store: SessionStore, node: NodeId): MenuItem[] {
  const s = store.getState();
  const kind = s.plan && planIndex(s.plan).nodes.get(node)?.kind;
  const name = s.sel?.split(/[[.]/)[0] ?? '';
  if (kind === 'workflow') return [{ label: 'Add a job…', keys: 'A', run: (g) => g.addJob() }];
  if (kind === 'job')
    return [
      { label: `Add a job after ${name}…`, keys: 'A', run: (g) => g.addJob() },
      { label: `What ${name} needs…`, keys: 'N', run: (g) => g.needs() },
      { label: `Add a step to ${name}…`, keys: 'S', run: (g) => g.palette() },
      { label: `Rename ${name}…`, keys: 'F2', run: (g) => g.rename() },
      { label: `Remove job ${name}`, keys: 'Delete', run: (g) => g.remove() },
    ];
  if (kind === 'step')
    return [
      { label: 'Add a step after this one…', keys: 'S', run: (g) => g.palette() },
      { label: 'Move up', keys: 'Alt+ArrowUp', run: (g) => g.move(-1) },
      { label: 'Move down', keys: 'Alt+ArrowDown', run: (g) => g.move(1) },
      { label: 'Rename its id…', keys: 'F2', run: (g) => g.rename() },
      { label: 'Remove this step', keys: 'Delete', run: (g) => g.remove() },
    ];
  return [];
}

export function RowMenu({ node, anchor, onClose }: { node: NodeId; anchor: Element; onClose: () => void }) {
  const { store } = useApp();
  const items = menuItems(store, node);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : undefined;
    if (to === undefined || all.length === 0) return;
    e.preventDefault();
    all[(to + all.length) % all.length]?.focus();
  };
  const take = (item: MenuItem): void => {
    onClose();
    const g = gestures.of(store);
    if (g) item.run(g);
  };
  return (
    <AnchoredPopover
      anchor={anchor}
      side="right"
      label="Actions"
      role="menu"
      onClose={onClose}
      frame="border border-border bg-surface p-1"
      className="w-56"
    >
      <div ref={list} role="presentation" className="flex flex-col" onKeyDown={onKeyDown}>
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-keyshortcuts={item.keys}
            className="flex justify-between gap-3 rounded px-2 py-1 text-left hover:bg-chrome focus-visible:bg-accent-soft focus-visible:outline-none"
            onClick={() => take(item)}
          >
            <span>{item.label}</span>
            {item.keys && <kbd className="font-mono text-muted">{item.keys.replace('Arrow', '')}</kbd>}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}
