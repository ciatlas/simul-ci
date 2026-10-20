import { useSyncExternalStore } from 'react';
import { viewport } from '../graph/commands';
import { cardOf } from '../graph/navigate';
import { planIndex, resolveSelection } from '../plan/index';
import type { PanelTab, Prefs } from '../state/prefs';
import type { SessionActions, SessionState, SessionStore } from '../state/store';
import { historyCommand } from '../lib/history-keys';
import { caseAvailability } from '../testcase/case';

/**
 * The page's keys outside the canvas (synthesis § 11): `t` switches between the graph and the text, `f` fits, `.`
 * centres the selection, `0` shows 100 %; `r` jumps to the Reasons tab and `1`–`4` open a tab of the right panel;
 * `[`, `]` and `\` close and open the scenario column, the right panel and the YAML pane; `c` opens Copy as test
 * case while there is a plan and a focused workflow; `e` turns edit mode on and off, and in edit mode `i` puts the
 * focus in the selected job's or step's Run if (synthesis § 4.2). None fires while the author
 * types (an input, a textarea, a select, an editable region such as the YAML pane), inside an open dialog, or once
 * something on the way handled the key (the canvas, a tree item: they prevent its default). None fires while the
 * author has turned them off (`prefs.keys`, the top bar's Shortcuts button; WCAG 2.1.4); the canvas's own keys need
 * the focus in the canvas and stay. Below 1024 px the text view is the only one, so `t` has nothing to switch.
 *
 * In edit mode Mod+Z undoes and Mod+Shift+Z or Mod+Y redoes the page's one edit history (synthesis § 6) wherever no
 * field keeps its own undo: whatever `prefs.keys` says, since a modifier makes them no single keys. The YAML pane
 * binds the same keys itself.
 */

export type PageCommand =
  | 'view'
  | 'fit'
  | 'centre'
  | 'actualSize'
  | 'reasons'
  | 'case'
  | 'edit'
  | 'runIf'
  | `panel:${PanelTab}`
  | `pane:${Pane}`;

type Pane = keyof Prefs['collapsed'];

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
  ['c', 'case'],
  ['e', 'edit'],
  ['i', 'runIf'],
  ['1', 'panel:reasons'],
  ['2', 'panel:unknowns'],
  ['3', 'panel:node'],
  ['4', 'panel:problems'],
  ['[', 'pane:left'],
  [']', 'pane:right'],
  ['\\', 'pane:yaml'],
]);

/**
 * Where an undo key is not the page's: a field or an editable region keeps its own undo until it commits, and an open
 * dialog keeps the keys. A read-only YAML pane is none of these: Mod+Z there undoes the page's last edit.
 */
const HISTORY_OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"]';

/** Where a key is not the page's: form fields, editable regions, the YAML pane even read-only, an open dialog. */
const OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, dialog, [role="dialog"]';

/** The command a key gives the page, if it is the page's to take. */
export function keyFor(event: PageKey): PageCommand | undefined {
  const command = COMMANDS.get(event.key);
  if (!command || event.defaultPrevented || held(event) || ownedElsewhere(event.target)) return undefined;
  return command;
}

/** The symbols some layouts type with Option (a German or Nordic Mac) or AltGr (Ctrl and Alt on a European PC). */
const SYMBOLS: ReadonlySet<string> = new Set(['[', ']', '\\']);

/**
 * A modifier makes it someone else's key: Ctrl+F finds, Cmd+0 resets the zoom, Alt types a character. For `[`, `]`
 * and `\` the key already is the symbol typed, so Alt, alone or with Ctrl, only says how the layout types it; Ctrl
 * alone or Cmd still makes it someone else's.
 */
function held(event: PageKey): boolean {
  if (event.metaKey || event.isComposing === true) return true;
  if (SYMBOLS.has(event.key)) return event.ctrlKey && !event.altKey;
  return event.altKey || event.ctrlKey;
}

function ownedElsewhere(target: EventTarget | null, owners = OWNERS): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.isContentEditable === true || el.closest(owners) !== null;
}

/** Listens for the page keys on the window; the returned function stops. */
export function installShortcuts(store: SessionStore, win: Window = window): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const s = store.getState();
    if (historyKey(event, s)) {
      event.preventDefault();
      return;
    }
    if (!s.ui.prefs.keys) return;
    const command = keyFor(event);
    if (command && run(command, s, win)) event.preventDefault();
  };
  win.addEventListener('keydown', onKey);
  return () => win.removeEventListener('keydown', onKey);
}

/**
 * Mod+Z, Mod+Shift+Z and Mod+Y in edit mode, where no field or editor owns the key: true when one was run, so the
 * browser's own (an input's undo, nothing at all on the page) does not run too.
 */
export function historyKey(event: HistoryKey, s: SessionState & SessionActions): boolean {
  const command =
    s.edit.on && !ownedElsewhere(event.target, HISTORY_OWNERS) ? historyCommand(event) : undefined;
  if (command === 'redo') s.redo();
  else if (command === 'undo') s.undo();
  return command !== undefined;
}

type HistoryKey = PageKey & { shiftKey?: boolean; code?: string };

/** Runs a command; false when it has nothing to act on, so the key goes on as if unheard. */
function run(command: PageCommand, s: SessionState & SessionActions, win: Window): boolean {
  if (command.startsWith('panel:')) {
    const tab = command.slice('panel:'.length) as PanelTab;
    // A key pressed inside the panel would leave the focus on the tab that goes: it follows to the new one.
    const inPanel = win.document?.activeElement?.closest('[role="tabpanel"]') != null;
    showPanel(s, tab);
    if (inPanel) focusPanel(tab, win);
    return true;
  }
  if (command.startsWith('pane:')) {
    togglePaneKeepingFocus(s, command.slice('pane:'.length) as Pane, win.document);
    return true;
  }
  if (command === 'edit' || command === 'runIf') return runEdit(command, s);
  if (command === 'case') {
    if (!caseAvailability(s).ok) return false;
    s.openCase();
    return true;
  }
  if (command === 'reasons') {
    showPanel(s, 'reasons');
    focusPanel('reasons', win);
    return true;
  }
  return runView(command, s, win.innerWidth);
}

/**
 * `e` turns edit mode on and off; in edit mode `i` puts the focus in Run if of the selected job or step of the focused
 * workflow (the workflow has no `if:`, and a called workflow's job is not its file's).
 */
function runEdit(command: 'edit' | 'runIf', s: SessionState & SessionActions): boolean {
  if (command === 'edit') {
    s.setEdit(!s.edit.on);
    return true;
  }
  if (!s.edit.on || !s.sel || s.sel.includes('/')) return false;
  s.focusProperty('if');
  return true;
}

/**
 * Opens or closes a pane (`data-pane` in app/SimulateView.tsx). A pane that closes with the focus inside it first
 * hands the focus to the plan (`data-plan`), so the focus never drops to the page's body.
 */
export function togglePaneKeepingFocus(
  s: Pick<SessionState, 'ui'> & Pick<SessionActions, 'togglePane'>,
  pane: Pane,
  doc: Document = document,
): void {
  const open = !s.ui.prefs.collapsed[pane];
  if (open && doc.querySelector(`[data-pane="${pane}"]`)?.contains(doc.activeElement)) {
    doc.querySelector<HTMLElement>('[data-plan]')?.focus();
  }
  s.togglePane(pane);
}

/**
 * Puts the focus in a right-panel tab's panel (`data-panel` in panels/Panels.tsx; Base UI owns the ids) once the
 * store's change has rendered it: after `r`, and after a button inside the panel opened another tab.
 */
export function focusPanel(tab: PanelTab, win: Window = window): void {
  win.requestAnimationFrame(() => win.document.querySelector<HTMLElement>(`[data-panel="${tab}"]`)?.focus());
}

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
