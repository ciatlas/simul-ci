import { yaml } from '@codemirror/lang-yaml';
import { syntaxHighlighting } from '@codemirror/language';
import {
  Compartment,
  EditorState,
  type Extension,
  type Range,
  RangeSet,
  StateEffect,
  type StateEffectType,
  StateField,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  lineNumbers,
} from '@codemirror/view';
import type { NodeId, Tri } from '@simulci/engine';
import type { DecidingLines, ProblemLine } from './locs';

/**
 * The YAML pane's CodeMirror: read-only, line numbers, YAML highlighting over the page's tokens, and three
 * decorations the pane sets from the plan with effects — the verdict gutter, the selection's deciding line (and its
 * own line when the two differ), the lines the parsers refused — plus the flash a revealed line gets. Colours are the
 * token sheet's CSS variables, so the theme follows the page; `dark` only tells CodeMirror's own defaults.
 */

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
}

/** The extensions of one file's state. */
function paneExtensions({ path, dark, onMark }: PaneOptions): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // Focusable, so the keyboard can scroll it; named, so a screen reader says which file and that it is read-only.
    EditorView.contentAttributes.of({
      'aria-label': `${path}, read-only`,
      'aria-readonly': 'true',
      tabindex: '0',
    }),
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

/**
 * The states of the files of one version, so a file shown again keeps where it was scrolled. A new version of the
 * files drops the states of the old one.
 */
export class PaneDocs {
  #docs = new Map<string, { state: EditorState; scroll?: StateEffect<unknown> }>();
  #shown: string | undefined;
  #version: number | undefined;
  #view: EditorView | undefined;
  #create: (path: string, text: string) => EditorState;

  constructor(create: (path: string, text: string) => EditorState) {
    this.#create = create;
  }

  /**
   * Puts a file's state in the view unless it is there already. Returns the effects that scroll it back to where it
   * was left, when it was shown before.
   */
  show(view: EditorView, path: string, version: number, text: string): StateEffect<unknown>[] {
    if (this.#version !== version) {
      this.#docs.clear();
      this.#shown = undefined;
      this.#version = version;
    }
    // Another view (React's second mount in development) shows nothing yet.
    if (this.#view !== view) {
      this.#view = view;
      this.#shown = undefined;
    }
    if (this.#shown === path) return [];
    // A state put aside keeps its place, not a flash that would play again when it comes back.
    if (this.#shown !== undefined) {
      const state = view.state.update({ effects: setFlash.of(undefined) }).state;
      this.#docs.set(this.#shown, { state, scroll: view.scrollSnapshot() });
    }
    const doc = this.#docs.get(path) ?? { state: this.#create(path, text) };
    this.#docs.set(path, doc);
    view.setState(doc.state);
    this.#shown = path;
    return doc.scroll ? [doc.scroll] : [];
  }

  /** The file the view shows. */
  get shown(): string | undefined {
    return this.#shown;
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
