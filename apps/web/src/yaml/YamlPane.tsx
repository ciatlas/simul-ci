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
import type { PlanState, Reveal, SessionState, SessionStore } from '../state/store';
import type { Outline } from '../worker/protocol';
import {
  blankState,
  FLASH_MS,
  followPageTheme,
  type GutterMark,
  PaneDocs,
  pageIsDark,
  paneState,
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

/**
 * The YAML pane (synthesis § 8): the loaded files as tabs over one read-only CodeMirror view with the verdict gutter,
 * the selection's deciding line and the lines the parsers refused. It shows the file that decided the selection
 * until the author picks a tab; a `file:line` link (`revealLine`) switches to its file, centres the line and flashes
 * it once. Pressing a mark selects its node. Nothing here takes the focus.
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
      <FileTabs tabs={model.tabs} active={active} ids={ids} />
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

/** What the pane shows, from the store. */
function usePaneModel(): PaneModel {
  const files = useSession((s) => s.files);
  const outline = useSession((s) => s.project.outline);
  const current = useSession((s) => s.plan);
  const focus = useSession((s) => s.focus);
  const sel = useSession((s) => s.sel);
  const picked = useSession((s) => s.ui.yamlFile);
  const representative = useSession((s) => s.ui.representative);
  // A plan of other files would put its marks on the wrong lines.
  const plan = current?.for.files === files.version ? current : undefined;
  const tabs = useMemo(() => fileTabs(outline, files.byPath), [outline, files.byPath]);
  const node = plan ? resolveSelection(planIndex(plan), focus, sel) : undefined;
  const path = shownFile({ tabs, picked, plan, node, focus });
  const lines = usePaneLines(plan, outline, path, node, representative);
  return { files, tabs, path, node, lines };
}

/** The view, the file it shows with its lines, the selection's scroll and the requested line. */
function useEditor(host: RefObject<HTMLDivElement | null>, { files, path, node, lines }: PaneModel): void {
  const { store } = useApp();
  const reveal = useSession((s) => s.reveal);
  const nearest = useRef(false);
  const docs = useDocs(store, nearest);
  const view = useEditorView(host);
  const text = path === undefined ? undefined : files.byPath[path];
  useLayoutEffect(() => {
    if (!view || path === undefined || text === undefined) return;
    const scroll = docs.show(view, path, files.version, text);
    view.dispatch({
      effects: [
        // A state made earlier may hold the other theme.
        themeCompartment.reconfigure(themeFor(pageIsDark())),
        setMarks.of(lines.marks),
        setDeciding.of(lines.deciding),
        setProblems.of(lines.problems),
        ...scroll,
      ],
    });
  }, [view, docs, path, files.version, text, lines]);
  useSelectionScroll(view, node, lines.deciding, nearest);
  useReveal(view, path, reveal);
}

function PaneFooter({ path }: { path: string | undefined }) {
  const togglePane = useSession((s) => s.togglePane);
  return (
    <footer className="flex items-center gap-3 border-border border-t bg-chrome px-3 py-1 text-muted text-xs">
      <span className="min-w-0 truncate font-mono">{path}</span>
      <span className="shrink-0">read-only in this version</span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-text hover:bg-surface"
        aria-label="Close the workflow source"
        onClick={() => togglePane('yaml')}
      >
        Close
      </button>
    </footer>
  );
}

/** The last reveal a pane showed, so a pane opened again does not show it twice. */
let revealed = 0;

interface PaneLines {
  marks: GutterMark[];
  deciding: DecidingLines | undefined;
  problems: ProblemLine[];
}

/** What the shown file's lines carry: verdict marks and the deciding line from the plan, problems from the outline. */
function usePaneLines(
  plan: PlanState | undefined,
  outline: Outline | undefined,
  path: string | undefined,
  node: NodeId | undefined,
  representative: SessionState['ui']['representative'],
): PaneLines {
  const labels = useMemo(() => (plan ? planLabels(plan.plan) : undefined), [plan]);
  return useMemo(() => {
    const problems = path === undefined ? [] : problemLines(outline, path);
    if (!plan || !labels || path === undefined) return { marks: [], deciding: undefined, problems };
    const marks = gutterMarks(plan.plan, outline, path, representative).map((m) => ({
      line: m.line,
      node: m.node,
      verdict: m.verdict,
      title: `${labels.get(m.node) ?? m.node}: ${MARK_LABEL[m.verdict]}`,
    }));
    return { marks, deciding: decidingLines(plan.plan, plan.derived, node, path), problems };
  }, [plan, labels, outline, path, node, representative]);
}

/** The files' states for this pane; a pressed mark selects its node and keeps the pane on the file it is in. */
function useDocs(store: SessionStore, nearest: RefObject<boolean>): PaneDocs {
  const [docs] = useState(
    () =>
      new PaneDocs((path, text) =>
        paneState(text, {
          path,
          dark: pageIsDark(),
          onMark: (node) => selectMark(store, node, docs.shown, nearest),
        }),
      ),
  );
  return docs;
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

/** A new selection brings its deciding line (else its own line) to the middle; a new plan alone moves nothing. */
function useSelectionScroll(
  view: EditorView | undefined,
  node: NodeId | undefined,
  deciding: DecidingLines | undefined,
  nearest: RefObject<boolean>,
): void {
  const last = useRef<NodeId | undefined>(undefined);
  useEffect(() => {
    if (!view || node === undefined || node === last.current) return;
    last.current = node;
    const y = nearest.current ? 'nearest' : 'center';
    nearest.current = false;
    const line = deciding?.line ?? deciding?.own;
    if (line !== undefined) view.dispatch({ effects: scrollToLine(view.state, line, y) });
  }, [view, node, deciding, nearest]);
}

/** A requested line, once its file is shown: centred and flashed once, without the flash for reduced motion. */
function useReveal(view: EditorView | undefined, path: string | undefined, reveal: Reveal | undefined): void {
  const applied = useRef(revealed);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!view || !reveal || reveal.seq <= applied.current || reveal.file !== path) return;
    applied.current = reveal.seq;
    revealed = Math.max(revealed, reveal.seq);
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

/** The files as tabs; a file with problems has a red dot and says so. The arrows move between tabs and open them. */
function FileTabs({ tabs, active, ids }: { tabs: readonly FileTab[]; active: number; ids: string }) {
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
          aria-label={tab.problems > 0 ? `${tab.label}, has problems` : tab.label}
          tabIndex={i === active || (active < 0 && i === 0) ? 0 : -1}
          title={tab.path}
          className="flex shrink-0 items-center gap-1.5 rounded-t px-2.5 py-1 font-mono text-muted text-xs hover:text-text aria-selected:bg-surface aria-selected:text-text"
          onClick={() => onPick(tab.path)}
        >
          {tab.label}
          {tab.problems > 0 && <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />}
        </button>
      ))}
    </div>
  );
}
