import type { Extension, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { NodeId } from '@simulci/engine';
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useApp, useSession } from '../app/providers';
import { MARK_LABEL } from '../graph/Mark';
import { planLabels } from '../panels/outline-tree';
import { planIndex, resolveSelection, selectionOf } from '../plan/index';
import {
  newestOutline,
  newestOutlined,
  type PlanState,
  type Reveal,
  type SessionState,
  type SessionStore,
  writable,
} from '../state/store';
import { eolOf } from './bridge';
import type { Outline } from '../worker/protocol';
import {
  blankState,
  editCompartment,
  FLASH_MS,
  followPageTheme,
  type GutterMark,
  PaneDocs,
  type PaneEdits,
  pageIsDark,
  paneState,
  scrollOwnTo,
  scrollToLine,
  setDeciding,
  setFlash,
  setMarks,
  setProblems,
  themeCompartment,
  themeFor,
} from './extensions';
import {
  type DecidingLines,
  decidingLines,
  type FileTab,
  fileTabs,
  gutterMarks,
  type ProblemLine,
  problemLines,
  shownFile,
} from './locs';
import { PaneFooter } from './PaneFooter';
import { paneEditing } from './pane-edit';

/**
 * The YAML pane (synthesis § 8, § 4.3): the loaded files as tabs over one CodeMirror view with the verdict gutter,
 * the selection's deciding line and the lines the parsers refused. In edit mode a writable file is edited here: each
 * change goes to the store through the bridge, and changes from the store (undo, an op, a restore) come back as
 * CodeMirror changes, so the cursor stays where it was. It shows the file that decided the selection until the author
 * picks a tab; a `file:line` link (`revealLine`) switches to its file, centres the line and flashes it once. Pressing
 * a mark selects its node. Nothing here takes the focus; closing the pane while it holds the focus hands it to the
 * plan.
 */
export function YamlPane() {
  const model = usePaneModel();
  const host = useRef<HTMLDivElement>(null);
  useEditor(host, model);
  const ids = useId();
  const active = model.tabs.findIndex((t) => t.path === model.path);
  const labelled = active >= 0 ? { role: 'tabpanel', 'aria-labelledby': `${ids}-tab-${active}` } : {};
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <FileTabs tabs={model.tabs} active={active} ids={ids} files={model.files} />
      <div id={`${ids}-panel`} {...labelled} className="min-h-0 flex-1 overflow-hidden">
        {model.tabs.length === 0 && <p className="p-3 text-muted text-xs">No files are loaded.</p>}
        <div ref={host} className="h-full" />
      </div>
      <PaneFooter path={model.path} />
    </div>
  );
}

interface PaneModel {
  files: SessionState['files'];
  tabs: FileTab[];
  /** The file shown. */
  path: string | undefined;
  /** The selected node, while the plan answers these files. */
  node: NodeId | undefined;
  lines: PaneLines;
}

/**
 * What the pane shows, from the store. The plan on screen says what is selected and which file the pane follows,
 * also while it is of older texts than the store's (an edit not answered yet): the selection and the file stay. Only
 * a plan and an Outline of the texts shown put anything on lines; one of older texts would put it on the wrong ones.
 */
function usePaneModel(): PaneModel {
  const files = useSession((s) => s.files);
  // While held, the Outline of the broken texts: its problems are what the author is fixing (synthesis § 7.2).
  const outline = useSession(newestOutline);
  const outlined = useSession(newestOutlined);
  const plan = useSession((s) => s.plan);
  const focus = useSession((s) => s.focus);
  const sel = useSession((s) => s.sel);
  const picked = useSession((s) => s.ui.yamlFile);
  const representative = useSession((s) => s.ui.representative);
  const tabs = useMemo(() => fileTabs(outline, files.byPath), [outline, files.byPath]);
  const node = plan ? resolveSelection(planIndex(plan), focus, sel) : undefined;
  const path = shownFile({ tabs, picked, plan, node, focus });
  const lines = usePaneLines(
    { plan: currentFor(plan, files), outline: outlined === files.version ? outline : undefined },
    path,
    node,
    representative,
  );
  return { files, tabs, path, node, lines };
}

/** The plan when it is of the texts in the store. */
const currentFor = (plan: PlanState | undefined, files: SessionState['files']): PlanState | undefined =>
  plan?.for.files === files.version ? plan : undefined;

/**
 * The view, the file it shows with its lines, the selection's scroll and the requested line. The lines are set only
 * when the store has them for the texts shown; until then the ones set last map through the edits.
 */
function useEditor(host: RefObject<HTMLDivElement | null>, { files, path, node, lines }: PaneModel): void {
  const { store } = useApp();
  const reveal = useSession((s) => s.reveal);
  // What decides whether the shown file is writable: edit mode, an unlock, its meta, its generated marker.
  const writableNow = useSession((s) => (path === undefined ? false : writable(s, path).ok));
  const nearest = useRef(false);
  const { docs, editing } = useDocs(store, nearest);
  const view = useEditorView(host);
  const text = path === undefined ? undefined : files.byPath[path];
  const rev = (path === undefined ? undefined : files.revs[path]) ?? 0;
  const { epoch } = files;
  useLayoutEffect(() => {
    if (!view || path === undefined || text === undefined) return;
    const scroll = docs.show(view, path, { epoch, rev }, text, editsFor(files, path));
    view.dispatch({
      effects: [
        // A state made earlier may hold the other theme, or be read-only where the file is writable now.
        themeCompartment.reconfigure(themeFor(pageIsDark())),
        ...configured(view, editing(path)),
        ...lineEffects(lines),
        ...scroll,
      ],
    });
  }, [view, docs, editing, path, epoch, rev, text, lines, files, writableNow]);
  useSelectionScroll(view, node, lines.plan, nearest, epoch);
  useReveal(view, path, reveal);
}

/** The store's edits that made the shown rev of a file, when the last commit did and the file has one line ending. */
function editsFor(files: SessionState['files'], path: string): PaneEdits | undefined {
  const { edited } = files;
  const edits = edited?.edits[path];
  const from = edited?.revs[path];
  const meta = files.meta[path];
  if (!edited || !edits || from === undefined || edited.version !== files.revs[path] || meta?.eol === 'mixed')
    return undefined;
  return { from, edits, eol: eolOf(meta) };
}

/** The effect that puts a file's edit extension in the view, unless it holds that one already. */
const configured = (view: EditorView, extension: Extension): StateEffect<unknown>[] =>
  editCompartment.get(view.state) === extension ? [] : [editCompartment.reconfigure(extension)];

/** The effects that set the lines the store has for the texts shown, and leave the others to map. */
function lineEffects({ plan, problems }: PaneLines): StateEffect<unknown>[] {
  return [
    ...(plan ? [setMarks.of(plan.marks), setDeciding.of(plan.deciding)] : []),
    ...(problems ? [setProblems.of(problems)] : []),
  ];
}

/** The last reveal a pane showed, so a pane opened again does not show it twice. */
let revealed = 0;

interface PaneLines {
  /** The verdict marks and the selection's lines, from a plan of the texts shown; absent while there is none. */
  plan?: { marks: GutterMark[]; deciding: DecidingLines | undefined };
  /** The lines the parsers refused, from an Outline of the texts shown; absent while there is none. */
  problems?: ProblemLine[];
}

/**
 * What the shown file's lines carry: verdict marks and the deciding line from the plan, problems from the outline,
 * each only when it is of the texts shown.
 */
function usePaneLines(
  { plan, outline }: { plan: PlanState | undefined; outline: Outline | undefined },
  path: string | undefined,
  node: NodeId | undefined,
  representative: SessionState['ui']['representative'],
): PaneLines {
  const labels = useMemo(() => (plan ? planLabels(plan.plan) : undefined), [plan]);
  return useMemo(() => {
    if (path === undefined) return {};
    const problems = outline ? problemLines(outline, path) : undefined;
    if (!plan || !labels) return { problems };
    const marks = gutterMarks(plan, outline, path, representative, node).map((m) => ({
      line: m.line,
      node: m.node,
      verdict: m.verdict,
      title: `${labels.get(m.node) ?? m.node}: ${MARK_LABEL[m.verdict]}`,
    }));
    return { plan: { marks, deciding: decidingLines(plan.plan, plan.derived, node, path) }, problems };
  }, [plan, labels, outline, path, node, representative]);
}

/**
 * The files' states for this pane, each made writable or read-only as the store says; a pressed mark selects its
 * node and keeps the pane on the file it is in.
 */
function useDocs(
  store: SessionStore,
  nearest: RefObject<boolean>,
): { docs: PaneDocs; editing: (path: string) => Extension } {
  const [made] = useState(() => {
    let docs: PaneDocs | undefined;
    const editing = paneEditing(store, () => docs);
    docs = new PaneDocs((path, text) =>
      paneState(text, {
        path,
        dark: pageIsDark(),
        onMark: (node) => selectMark(store, node, docs?.shown, nearest),
        editing: editing(path),
      }),
    );
    return { docs, editing };
  });
  return made;
}

function selectMark(
  store: SessionStore,
  node: NodeId,
  file: string | undefined,
  nearest: RefObject<boolean>,
): void {
  const s = store.getState();
  if (!s.plan) return;
  const { focus, sel } = selectionOf(planIndex(s.plan), node);
  // The pressed mark is in view, so its deciding line only needs to come into view; the selection's own mark moves
  // nothing. Set before selecting: the scroll may run inside `select`.
  nearest.current = s.focus !== focus || s.sel !== sel;
  s.select(focus, sel);
  if (file !== undefined) s.setYamlFile(file);
}

/** One view for the pane's life, destroyed with it. */
function useEditorView(host: RefObject<HTMLDivElement | null>): EditorView | undefined {
  const [view, setView] = useState<EditorView>();
  useEffect(() => {
    const parent = host.current;
    if (!parent) return undefined;
    const created = new EditorView({ parent, state: blankState() });
    const stop = followPageTheme(created);
    setView(created);
    return () => {
      stop();
      created.destroy();
    };
  }, [host]);
  return view;
}

/**
 * A new selection brings its deciding line (else its own line) to the middle once a plan of the texts shown places
 * it, and so does the first plan of a new source, whose states start over; a new plan of the same source, an edit's
 * included, moves nothing.
 */
function useSelectionScroll(
  view: EditorView | undefined,
  node: NodeId | undefined,
  placed: PaneLines['plan'],
  nearest: RefObject<boolean>,
  epoch: number,
): void {
  const last = useRef<{ node: NodeId; epoch: number }>(undefined);
  const line = placed?.deciding?.line ?? placed?.deciding?.own;
  const current = placed !== undefined;
  useEffect(() => {
    if (!view || node === undefined || !current || sameSelection(last.current, node, epoch)) return;
    last.current = { node, epoch };
    const y = nearest.current ? 'nearest' : 'center';
    nearest.current = false;
    if (line !== undefined) scrollOwnTo(view, line, y);
  }, [view, node, line, nearest, epoch, current]);
}

const sameSelection = (last: { node: NodeId; epoch: number } | undefined, node: NodeId, epoch: number) =>
  last?.node === node && last.epoch === epoch;

/**
 * A requested line, once its file is shown: centred and flashed once, without the flash for reduced motion. The view
 * takes each request once: one whose file it does not show then (the author chose another since) is dropped, not
 * played when the file comes up later.
 */
function useReveal(view: EditorView | undefined, path: string | undefined, reveal: Reveal | undefined): void {
  const applied = useRef(revealed);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!view || !reveal || reveal.seq <= applied.current) return;
    applied.current = reveal.seq;
    revealed = Math.max(revealed, reveal.seq);
    if (reveal.file !== path) return;
    const flash = !reducedMotion();
    view.dispatch({
      effects: [
        ...scrollToLine(view.state, reveal.line, 'center'),
        ...(flash ? [setFlash.of(reveal.line)] : []),
      ],
    });
    if (!flash) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => view.dispatch({ effects: setFlash.of(undefined) }), FLASH_MS);
  }, [view, path, reveal]);
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The tab a key moves to: ← and → wrap around, Home and End go to the ends. */
function movedTab(key: string, at: number, count: number): number | undefined {
  if (key === 'ArrowRight') return (at + 1) % count;
  if (key === 'ArrowLeft') return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}

/** How a tab names its file to a screen reader: its label, then what its dots say. */
const tabLabel = (tab: FileTab, dirty: boolean): string =>
  [tab.label, ...(dirty ? ['unsaved'] : []), ...(tab.problems > 0 ? ['has problems'] : [])].join(', ');

/**
 * The files as tabs; a file with unsaved edits has a dot, a file with problems a red one, and each says so. The arrows
 * move between tabs and open them.
 */
function FileTabs({
  tabs,
  active,
  ids,
  files,
}: {
  tabs: readonly FileTab[];
  active: number;
  ids: string;
  files: Pick<SessionState['files'], 'byPath' | 'base'>;
}) {
  const onPick = useSession((s) => s.setYamlFile);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const next = movedTab(e.key, Math.max(active, 0), tabs.length);
    const tab = next === undefined ? undefined : tabs[next];
    if (next === undefined || !tab) return;
    e.preventDefault();
    onPick(tab.path);
    buttons.current[next]?.focus();
  };
  if (tabs.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Files"
      className="flex shrink-0 gap-1 overflow-x-auto border-border border-b bg-chrome px-2 pt-1"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab, i) => (
        <button
          key={tab.path}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${ids}-tab-${i}`}
          aria-selected={i === active}
          aria-controls={`${ids}-panel`}
          aria-label={tabLabel(tab, files.byPath[tab.path] !== files.base[tab.path])}
          tabIndex={i === active || (active < 0 && i === 0) ? 0 : -1}
          title={tab.path}
          className="flex shrink-0 items-center gap-1.5 rounded-t px-2.5 py-1 font-mono text-muted text-xs hover:text-text aria-selected:bg-surface aria-selected:text-text"
          onClick={() => onPick(tab.path)}
        >
          {tab.label}
          {files.byPath[tab.path] !== files.base[tab.path] && (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-text" />
          )}
          {tab.problems > 0 && <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />}
        </button>
      ))}
    </div>
  );
}
