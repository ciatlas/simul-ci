import { useSyncExternalStore } from 'react';
import { viewport } from '../graph/commands';
import { cardOf } from '../graph/navigate';
import { planIndex, resolveSelection } from '../plan/index';
import type { PanelTab, Prefs } from '../state/prefs';
import type { SessionActions, SessionState, SessionStore } from '../state/store';

/**
 * The page's keys outside the canvas (synthesis § 11): `t` switches between the graph and the text, `f` fits, `.`
 * centres the selection, `0` shows 100 %; `r` jumps to the Reasons tab and `1`–`4` open a tab of the right panel;
 * `[`, `]` and `\` close and open the scenario column, the right panel and the YAML pane. None fires while the author
 * types (an input, a textarea, a select, an editable region such as the YAML pane), inside an open dialog, or once
 * something on the way handled the key (the canvas, a tree item: they prevent its default). Below 1024 px the text
 * view is the only one, so `t` has nothing to switch.
 */

export type PageCommand =
  | 'view'
  | 'fit'
  | 'centre'
  | 'actualSize'
  | 'reasons'
  | `panel:${PanelTab}`
  | `pane:${keyof Prefs['collapsed']}`;

/** What `keyFor` reads of a KeyboardEvent. */
export interface PageKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
}

const COMMANDS = new Map<string, PageCommand>([
  ['t', 'view'],
  ['f', 'fit'],
  ['.', 'centre'],
  ['0', 'actualSize'],
  ['r', 'reasons'],
  ['1', 'panel:reasons'],
  ['2', 'panel:unknowns'],
  ['3', 'panel:node'],
  ['4', 'panel:problems'],
  ['[', 'pane:left'],
  [']', 'pane:right'],
  ['\\', 'pane:yaml'],
]);

/** Where a key is not the page's: form fields, editable regions, the YAML pane even read-only, an open dialog. */
const OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, dialog, [role="dialog"]';

/** The command a key gives the page, if it is the page's to take. */
export function keyFor(event: PageKey): PageCommand | undefined {
  const command = COMMANDS.get(event.key);
  if (!command || event.defaultPrevented || held(event) || ownedElsewhere(event.target)) return undefined;
  return command;
}

/** A modifier makes it someone else's key: Ctrl+F finds, Cmd+0 resets the zoom, Alt types a character. */
const held = (event: PageKey): boolean =>
  event.altKey || event.ctrlKey || event.metaKey || event.isComposing === true;

function ownedElsewhere(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.isContentEditable === true || el.closest(OWNERS) !== null;
}

/** Listens for the page keys on the window; the returned function stops. */
export function installShortcuts(store: SessionStore, win: Window = window): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const command = keyFor(event);
    if (command && run(command, store.getState(), win)) event.preventDefault();
  };
  win.addEventListener('keydown', onKey);
  return () => win.removeEventListener('keydown', onKey);
}

/** Runs a command; false when it has nothing to act on, so the key goes on as if unheard. */
function run(command: PageCommand, s: SessionState & SessionActions, win: Window): boolean {
  if (command.startsWith('panel:')) return showPanel(s, command.slice('panel:'.length) as PanelTab);
  if (command.startsWith('pane:')) {
    s.togglePane(command.slice('pane:'.length) as keyof Prefs['collapsed']);
    return true;
  }
  if (command === 'reasons') {
    showPanel(s, 'reasons');
    // The tab's panel exists once the store's change has rendered.
    win.requestAnimationFrame(() =>
      win.document.querySelector<HTMLElement>(panelSelector('reasons'))?.focus(),
    );
    return true;
  }
  return runView(command, s, win.innerWidth);
}

/** A right-panel tab's panel (`data-panel` in panels/Panels.tsx; Base UI owns the ids), so a key can focus it. */
const panelSelector = (tab: PanelTab): string => `[data-panel="${tab}"]`;

/** Opens the right panel on a tab. */
function showPanel(s: SessionState & SessionActions, tab: PanelTab): boolean {
  if (s.ui.prefs.collapsed.right) s.togglePane('right');
  s.setPanel(tab);
  return true;
}

function runView(command: PageCommand, s: SessionState & SessionActions, width: number): boolean {
  if (command === 'view') {
    if (isNarrow(width)) return false;
    s.setView(s.ui.view === 'graph' ? 'text' : 'graph');
    return true;
  }
  if (command === 'centre') return centreSelection(s);
  if (command === 'fit') viewport.fit();
  else viewport.actualSize();
  return true;
}

/** The card that shows the selection, brought into view; nothing before the canvas has a picture. */
function centreSelection(s: SessionState): boolean {
  if (!s.plan || !s.graph) return false;
  const node = resolveSelection(planIndex(s.plan), s.focus, s.sel);
  const card = node === undefined ? undefined : cardOf(s.graph.model, node);
  if (card === undefined) return false;
  viewport.centre(card);
  return true;
}

/** Below this width the screen has no room for the canvas beside the panels: the text view is forced. */
const NARROW_BELOW = 1024;

export const isNarrow = (width: number): boolean => width < NARROW_BELOW;

/** The view the screen shows: the text below 1024 px, whatever the author picked. */
export const shownView = (view: 'graph' | 'text', narrow: boolean): 'graph' | 'text' =>
  narrow ? 'text' : view;

function onResize(change: () => void): () => void {
  window.addEventListener('resize', change);
  return () => window.removeEventListener('resize', change);
}

/** Whether the window is narrower than 1024 px, following resizes. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    onResize,
    () => isNarrow(window.innerWidth),
    () => false,
  );
}
