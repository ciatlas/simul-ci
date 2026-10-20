import { yaml } from '@codemirror/lang-yaml';
import { syntaxHighlighting } from '@codemirror/language';
import {
  Annotation,
  type ChangeSpec,
  Compartment,
  EditorState,
  type Extension,
  type Range,
  RangeSet,
  StateEffect,
  type StateEffectType,
  StateField,
  type Text,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  lineNumbers,
} from '@codemirror/view';
import type { TextEdit } from '@simulci/document/edits';
import type { NodeId, Tri } from '@simulci/engine';
import { agrees, type Eol, toChanges } from './bridge';
import type { DecidingLines, ProblemLine } from './locs';

/**
 * The YAML pane's CodeMirror: line numbers, YAML highlighting over the page's tokens, and three decorations the pane
 * sets from the plan with effects — the verdict gutter, the selection's deciding line (and its own line when the two
 * differ), the lines the parsers refused — plus the flash a revealed line gets. Each maps through a change of the
 * text, so it stays on its line until the pane sets it again. A file's state is read-only until edit mode makes it
 * writable through `editCompartment` (`yaml/editing.ts`). Colours are the token sheet's CSS variables, so the theme
 * follows the page; `dark` only tells CodeMirror's own defaults.
 */

/** Marks a transaction that brings the store's text in (undo, an op, a restore): nothing hands it back to the store. */
export const fromStore = Annotation.define<boolean>();

/** Read-only, or writable in edit mode: swapped as the file's state in the store changes. */
export const editCompartment = new Compartment();

/** A read-only file: focusable, so the keyboard can scroll it, and named so a screen reader says which and how. */
export function readOnlyExtensions(path: string): Extension {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({
      'aria-label': `${path}, read-only`,
      'aria-readonly': 'true',
      tabindex: '0',
    }),
  ];
}

/** A verdict mark as the gutter draws it: the node declared on the line and a title that names it. */
export interface GutterMark {
  line: number;
  node: NodeId;
  verdict: Tri;
  title: string;
}

/** Replaces the verdict marks. */
export const setMarks = StateEffect.define<readonly GutterMark[]>();
/** Replaces the deciding line and the selection's own line; undefined clears them. */
export const setDeciding = StateEffect.define<DecidingLines | undefined>();
/** Replaces the problem lines. */
export const setProblems = StateEffect.define<readonly ProblemLine[]>();
/** Flashes a line once; undefined ends the flash. */
export const setFlash = StateEffect.define<number | undefined>();

/** How long a revealed line flashes. */
export const FLASH_MS = 1200;

/** The theme, swapped when the page's `data-theme` changes. */
export const themeCompartment = new Compartment();

/** What a file's state is made with. */
export interface PaneOptions {
  /** The file's path, which names the text for a screen reader. */
  path: string;
  /** Whether the page is dark when the state is made. */
  dark: boolean;
  /** A verdict mark was pressed. */
  onMark: (node: NodeId) => void;
  /** Whether the file is writable when its state is made: what goes in `editCompartment`. */
  editing?: Extension;
}

/** The extensions of one file's state. */
function paneExtensions({ path, dark, onMark, editing }: PaneOptions): Extension[] {
  return [
    editCompartment.of(editing ?? readOnlyExtensions(path)),
    lineNumbers(),
    verdictGutter(onMark),
    yaml(),
    syntaxHighlighting(highlighter),
    themeCompartment.of(themeFor(dark)),
    marksField,
    decidingField,
    problemsField,
    flashField,
  ];
}

/** A file's state, read-only, with the pane's extensions. */
export function paneState(text: string, options: PaneOptions): EditorState {
  return EditorState.create({ doc: text, extensions: paneExtensions(options) });
}

/** What the view holds before a file is shown: nothing, and nothing to edit. */
export function blankState(): EditorState {
  return EditorState.create({
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': 'No file shown' }),
    ],
  });
}

/** Whether the page shows its dark theme (`data-theme`, set by app/theme.ts and public/theme.js). */
export function pageIsDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
}

/** Keeps a view's theme on the page's as `data-theme` changes; returns the function that stops it. */
export function followPageTheme(view: EditorView): () => void {
  const observer = new MutationObserver(() =>
    view.dispatch({ effects: themeCompartment.reconfigure(themeFor(pageIsDark())) }),
  );
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** Where a line begins, when the document has it. */
export function lineStart(doc: Text, line: number): number | undefined {
  return Number.isInteger(line) && line >= 1 && line <= doc.lines ? doc.line(line).from : undefined;
}

/** The effects that bring a line into view: to the middle, or only as far as it takes to be seen. */
export function scrollToLine(
  state: EditorState,
  line: number,
  y: 'center' | 'nearest',
): StateEffect<unknown>[] {
  const pos = lineStart(state.doc, line);
  return pos === undefined ? [] : [EditorView.scrollIntoView(pos, { y })];
}

/** Where a line sits in the editor's scroller, and how much of it shows. */
export interface LineBox {
  top: number;
  height: number;
  /** The scroller's visible height and its scroll offset. */
  view: number;
  scrolled: number;
}

/** The scroll offset that shows a line: in the middle, or the least move that brings it in (none when it shows). */
export function scrollTopFor(box: LineBox, y: 'center' | 'nearest'): number | undefined {
  if (y === 'center') return Math.max(0, box.top - (box.view - box.height) / 2);
  if (box.top < box.scrolled) return box.top;
  if (box.top + box.height > box.scrolled + box.view) return box.top + box.height - box.view;
  return undefined;
}

/** The key of the pane's own scroll among CodeMirror's measure requests: a newer one replaces one not yet run. */
export const OWN_SCROLL = 'sc-own-scroll';

/**
 * Scrolls the editor's own scroller to a line and nothing around it: `EditorView.scrollIntoView` also scrolls every
 * scrolling ancestor, which below 768 px is the whole page, so a selection made in the tree would carry the page to
 * the pane. A requested line (`revealLine`) still uses it, since that request is to see the line.
 */
export function scrollOwnTo(view: EditorView, line: number, y: 'center' | 'nearest'): void {
  const pos = lineStart(view.state.doc, line);
  if (pos === undefined) return;
  view.requestMeasure({
    key: OWN_SCROLL,
    read: (v): LineBox => {
      const block = v.lineBlockAt(pos);
      return {
        top: block.top,
        height: block.height,
        view: v.scrollDOM.clientHeight,
        scrolled: v.scrollDOM.scrollTop,
      };
    },
    write: (box, v) => {
      const top = scrollTopFor(box, y);
      if (top !== undefined) v.scrollDOM.scrollTop = top;
    },
  });
}

/**
 * The change that takes a document to a text: one replacement between their longest common start and end. The text
 * is split into lines as CodeMirror splits a document, so the positions are the document's own in a CRLF file too.
 */
function changesTo(doc: Text, text: string): { from: number; to: number; insert: string } {
  const before = doc.toString();
  const after = text.split(/\r\n?|\n/).join('\n');
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/** A transaction that brings the store's text in: nothing hands it back to the store. */
const fromStoreChange = (changes: ChangeSpec) => ({
  changes,
  annotations: [fromStore.of(true), Transaction.addToHistory.of(false)],
});

/** Which text of a file a state holds: the files' epoch, and the file's rev within it. */
export interface PaneText {
  epoch: number;
  rev: number;
}

/**
 * The store's edits that made `rev` from the text of rev `from`, and the file's line ending: a state that holds rev
 * `from` takes them as CodeMirror changes (`toChanges`), so its cursor maps through exactly what changed.
 */
export interface PaneEdits {
  from: number;
  edits: readonly TextEdit[];
  eol: Eol;
}

interface PaneDoc {
  state: EditorState;
  rev: number;
  scroll?: StateEffect<unknown>;
}

/**
 * The states of the files of one epoch, so a file shown again keeps where it was scrolled. A file whose text moved
 * on (its rev) gets the new text as a change of the state it has, shown or put aside: its marks, its selection and
 * its scroll map through the change, and stay on their lines until the plan of the new text replaces them. A new
 * epoch drops every state.
 */
export class PaneDocs {
  #docs = new Map<string, PaneDoc>();
  #shown: string | undefined;
  /** The rev of the text the shown state holds. */
  #rev = 0;
  #epoch: number | undefined;
  #view: EditorView | undefined;
  #create: (path: string, text: string) => EditorState;

  constructor(create: (path: string, text: string) => EditorState) {
    this.#create = create;
  }

  /**
   * Puts a file's state in the view unless it is there already, with the text given. Returns the effects that scroll
   * it back to where it was left, when it was shown before.
   */
  show(
    view: EditorView,
    path: string,
    at: PaneText,
    text: string,
    edits?: PaneEdits,
  ): StateEffect<unknown>[] {
    if (this.#epoch !== at.epoch) {
      this.#docs.clear();
      this.#shown = undefined;
      this.#epoch = at.epoch;
    }
    // Another view (React's second mount in development) shows nothing yet.
    if (this.#view !== view) {
      this.#view = view;
      this.#shown = undefined;
    }
    if (this.#shown === path) {
      if (this.#rev !== at.rev) this.#bringIn(view, text, edits);
      this.#rev = at.rev;
      return [];
    }
    // A state put aside keeps its place, not a flash that would play again when it comes back.
    if (this.#shown !== undefined) {
      const state = view.state.update({ effects: setFlash.of(undefined) }).state;
      this.#docs.set(this.#shown, { state, rev: this.#rev, scroll: view.scrollSnapshot() });
    }
    const doc = this.#kept(path, at.rev, text) ?? { state: this.#create(path, text), rev: at.rev };
    this.#docs.set(path, doc);
    view.setState(doc.state);
    this.#shown = path;
    this.#rev = at.rev;
    return doc.scroll ? [doc.scroll] : [];
  }

  /** The file the view shows. */
  get shown(): string | undefined {
    return this.#shown;
  }

  /** The author's change of the shown file reached the store as `rev`: the view holds that text already. */
  typed(path: string, rev: number): void {
    if (this.#shown === path) this.#rev = rev;
  }

  /**
   * The shown file brought to the store's text again, when the view and the store disagree: one change of the state
   * it has, so its cursor, its scroll and its marks map through it.
   */
  rebuild(view: EditorView, path: string, text: string, rev: number): void {
    if (this.#shown !== path || this.#view !== view) return;
    view.dispatch(fromStoreChange(changesTo(view.state.doc, text)));
    this.#rev = rev;
  }

  /**
   * Brings the shown state to the store's text: the store's own edits when they apply to the text it holds, else
   * one change between the two texts; and that one change too if the edits left the view out of step.
   */
  #bringIn(view: EditorView, text: string, edits: PaneEdits | undefined): void {
    const doc = view.state.doc;
    if (edits && edits.from === this.#rev) {
      view.dispatch(fromStoreChange(toChanges(doc, doc.sliceString(0, doc.length, edits.eol), edits.edits)));
      if (agrees(view.state.doc, text)) return;
    }
    view.dispatch(fromStoreChange(changesTo(view.state.doc, text)));
  }

  /** The state put aside for a file, brought to the text when the file's rev moved since. */
  #kept(path: string, rev: number, text: string): PaneDoc | undefined {
    const doc = this.#docs.get(path);
    if (!doc || doc.rev === rev) return doc;
    const changes = doc.state.changes(changesTo(doc.state.doc, text));
    return { state: doc.state.update({ changes }).state, rev, scroll: doc.scroll?.map(changes) };
  }
}

// The verdict gutter.

const SVG = 'http://www.w3.org/2000/svg';
const COLOUR: Record<Tri, string> = { yes: 'var(--run)', no: 'var(--skip)', maybe: 'var(--might)' };

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  return el;
}

/** graph/Mark.tsx's shapes: a filled circle runs, a ring is skipped, a half-filled ring might run. */
function markSvg(verdict: Tri): SVGSVGElement {
  const colour = COLOUR[verdict];
  const filled = verdict === 'yes';
  const svg = svgElement('svg', { width: '10', height: '10', viewBox: '0 0 10 10' });
  svg.append(
    svgElement('circle', {
      cx: '5',
      cy: '5',
      r: '4',
      stroke: colour,
      fill: filled ? colour : 'none',
      'stroke-width': filled ? '0' : '1.5',
    }),
  );
  if (verdict === 'maybe') svg.append(svgElement('path', { d: 'M5 1 A4 4 0 0 1 5 9 Z', fill: colour }));
  return svg;
}

/** A node's verdict on its line; hidden from a screen reader, which reads the verdicts in the outline tree. */
class VerdictMarker extends GutterMarker {
  readonly mark: GutterMark;

  constructor(mark: GutterMark) {
    super();
    this.mark = mark;
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof VerdictMarker &&
      other.mark.node === this.mark.node &&
      other.mark.verdict === this.mark.verdict &&
      other.mark.title === this.mark.title
    );
  }

  override toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-sc-mark';
    el.dataset.node = this.mark.node;
    el.title = this.mark.title;
    el.setAttribute('aria-hidden', 'true');
    el.append(markSvg(this.mark.verdict));
    return el;
  }
}

const marksField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    let next = markers.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) next = markerSet(tr.state.doc, e.value);
    return next;
  },
});

function markerSet(doc: Text, marks: readonly GutterMark[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  for (const mark of marks) {
    const pos = lineStart(doc, mark.line);
    if (pos !== undefined) ranges.push(new VerdictMarker(mark).range(pos));
  }
  return RangeSet.of(ranges, true);
}

/** The node whose mark is at a line's start, or under the pointer. */
export function markedNode(state: EditorState, pos: number, target?: EventTarget | null): NodeId | undefined {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-node]') : null;
  if (el?.dataset.node) return el.dataset.node;
  let node: NodeId | undefined;
  state.field(marksField, false)?.between(pos, pos, (_from, _to, marker) => {
    if (marker instanceof VerdictMarker) node = marker.mark.node;
  });
  return node;
}

function verdictGutter(onMark: (node: NodeId) => void): Extension {
  return gutter({
    class: 'cm-sc-verdicts',
    markers: (view) => view.state.field(marksField),
    domEventHandlers: {
      mousedown: (view, block, event) => {
        if (event instanceof MouseEvent && event.button !== 0) return false;
        const node = markedNode(view.state, block.from, event.target);
        if (node === undefined) return false;
        // Handled: the default is prevented, so pressing a mark does not move the focus.
        onMark(node);
        return true;
      },
    },
  });
}

// Line decorations.

function lineField<T>(
  effect: StateEffectType<T>,
  build: (doc: Text, value: T) => Range<Decoration>[],
): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, tr) {
      let next = decorations.map(tr.changes);
      for (const e of tr.effects) if (e.is(effect)) next = Decoration.set(build(tr.state.doc, e.value), true);
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function lineDecoration(doc: Text, line: number | undefined, decoration: Decoration): Range<Decoration>[] {
  const pos = line === undefined ? undefined : lineStart(doc, line);
  return pos === undefined ? [] : [decoration.range(pos)];
}

const decidingField = lineField(setDeciding, (doc, lines) => {
  if (!lines) return [];
  const attributes = { 'data-tone': lines.tone };
  return [
    ...lineDecoration(doc, lines.line, Decoration.line({ class: 'cm-sc-deciding', attributes })),
    ...lineDecoration(doc, lines.own, Decoration.line({ class: 'cm-sc-own', attributes })),
  ];
});

const problemsField = lineField(setProblems, (doc, problems) =>
  problems.flatMap((p) =>
    lineDecoration(
      doc,
      p.line,
      Decoration.line({ class: 'cm-sc-problem', attributes: { title: p.message } }),
    ),
  ),
);

const flashField = lineField(setFlash, (doc, line) =>
  lineDecoration(doc, line, Decoration.line({ class: 'cm-sc-flash' })),
);

/** The classes the decorations of a state hold, line by line: what a test reads without a layout. */
export function lineClasses(state: EditorState): Map<number, string[]> {
  const classes = new Map<number, string[]>();
  for (const field of [decidingField, problemsField, flashField]) {
    state.field(field, false)?.between(0, state.doc.length, (from, _to, d) => {
      const line = state.doc.lineAt(from).number;
      const spec = d.spec as { class?: string; attributes?: Record<string, string> };
      const tone = spec.attributes?.['data-tone'];
      classes.set(line, [...(classes.get(line) ?? []), tone ? `${spec.class}:${tone}` : (spec.class ?? '')]);
    });
  }
  return classes;
}

/** The marks a state holds, by line. */
export function gutterNodes(state: EditorState): Map<number, NodeId> {
  const nodes = new Map<number, NodeId>();
  state.field(marksField, false)?.between(0, state.doc.length, (from, _to, marker) => {
    if (marker instanceof VerdictMarker) nodes.set(state.doc.lineAt(from).number, marker.mark.node);
  });
  return nodes;
}

// Highlighting and the theme.

type Highlighter = Parameters<typeof syntaxHighlighting>[0];

/**
 * Lezer's highlight tags by name to the pane's classes, which the theme colours with the tokens: keys stand out by
 * weight, comments and punctuation recede, everything else is text. No verdict colour, which the marks own. A tag
 * falls back to its parents (`lineComment` to `comment`).
 */
const TOKEN_CLASS: Record<string, string> = {
  propertyName: 'cm-sc-key',
  comment: 'cm-sc-quiet cm-sc-comment',
  punctuation: 'cm-sc-quiet',
  meta: 'cm-sc-quiet',
  keyword: 'cm-sc-quiet',
  labelName: 'cm-sc-quiet',
  typeName: 'cm-sc-quiet',
};

const highlighter: Highlighter = {
  style(tags) {
    for (const tag of tags)
      for (const t of tag.set) {
        const name = TOKEN_CLASS[String(t)];
        if (name) return name;
      }
    return null;
  },
};

const TONES: [Tri, string][] = [
  ['yes', 'run'],
  ['no', 'skip'],
  ['maybe', 'might'],
];

const THEME: Parameters<typeof EditorView.theme>[0] = {
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--surface)', fontSize: '12px' },
  '&.cm-focused': { outline: 'none' },
  // The page's one focus ring, for the keyboard only.
  '&:has(.cm-content:focus-visible)': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '.cm-content:focus-visible': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 10px' },
  '.cm-sc-verdicts .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    width: '18px',
    paddingLeft: '4px',
  },
  '.cm-sc-mark': { display: 'inline-flex', cursor: 'pointer' },
  '.cm-sc-key': { fontWeight: '600' },
  '.cm-sc-quiet': { color: 'var(--muted)' },
  '.cm-sc-comment': { fontStyle: 'italic' },
  ...Object.fromEntries(
    TONES.map(([tone, token]) => [
      `.cm-sc-deciding[data-tone="${tone}"]`,
      { backgroundColor: `var(--${token}-soft)`, boxShadow: `inset 3px 0 0 var(--${token})` },
    ]),
  ),
  '.cm-sc-own': { backgroundColor: 'var(--chrome)', boxShadow: 'inset 3px 0 0 var(--border-strong)' },
  '.cm-sc-problem': {
    backgroundColor: 'color-mix(in srgb, var(--danger-soft) 60%, var(--surface))',
    textDecoration: 'underline wavy var(--danger)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-sc-flash': { animation: `cm-sc-flash ${FLASH_MS}ms ease-out 1` },
  '@keyframes cm-sc-flash': {
    from: { backgroundColor: 'var(--accent-soft)' },
    to: { backgroundColor: 'transparent' },
  },
};

const THEMES = {
  light: EditorView.theme(THEME, { dark: false }),
  dark: EditorView.theme(THEME, { dark: true }),
};

/** The pane's theme; `dark` only tells CodeMirror's own defaults, the colours are the page's tokens. */
export function themeFor(dark: boolean): Extension {
  return dark ? THEMES.dark : THEMES.light;
}
