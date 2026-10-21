import type { NodeId } from '@simulci/engine';
import {
  type AriaLabelConfig,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnMove,
  ReactFlow,
  ReactFlowProvider,
  type ReactFlowInstance,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react';
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useApp, useSession } from '../app/providers';
import { gestures, pendingEdges } from '../edit/gestures';
import { markEdit } from '../lib/marks';
import type { SessionState, SessionStore } from '../state/store';
import { cardActions, selectedNode } from './card';
import { type ViewportCommands, viewport } from './commands';
import { NeedsEdge } from './edges/NeedsEdge';
import {
  cardFocus,
  edgeIdOf,
  editKey,
  type Flow,
  type FlowNode,
  type FlowView,
  keepUnchanged,
  keyAction,
  type NavEffects,
  type NeedsFlowEdge,
  nodeIdOf,
  outsideView,
  runNav,
  toFlow,
} from './flow';
import { FLASH_MS, type Flash, flashOf, litCards, RING_MS, reducedMotion } from './highlight';
import { cardOf, createNavigator } from './navigate';
import { JobNode } from './nodes/JobNode';
import { WorkflowNode } from './nodes/WorkflowNode';
import type { GraphModel, GraphState } from './types';
import { doubleClickZoom, type MountView, mountView, type ViewMemory } from './view';
import './canvas.css';

/**
 * The run graph: the committed picture from the store as React Flow nodes, the selection from the URL's `sel`
 * resolved against the plan and written back through `select`. Nothing is draggable or connectable; the canvas
 * keys are ours (graph/navigate.ts) and React Flow's own are switched off where they would clash (Space pans,
 * Shift and Meta select). The first picture of a source is fitted once; after that the viewport moves only when the
 * author asks, an edit of the texts included, and a picture mounted again opens where it was left. Every node stays mounted (the node
 * count is bounded by workflows and jobs, never legs or steps), so the card with the focus never leaves the page
 * under it. An unknown hovered in the Unknowns tab fades the cards it does not affect; the cards a pin or an edit
 * changed flash once, and the cards an edit added get a ring for two seconds. For an author who asked for less motion
 * nothing on the canvas moves by itself: the viewport jumps, nothing flashes or rings, and index.css turns the
 * recolour transitions off.
 *
 * In edit mode the focused workflow's picture is the builder's (synthesis § 4.5): a drag from one job's handle onto
 * another's makes the second need the first, through ops like every other gesture, and a drag the document refuses
 * (the same job, another workflow, a need it has, a loop) draws a red line and connects nothing; an edge takes the
 * focus and shows ✕ (a click on it selects the job whose need it is), and Delete on it removes the need; Delete on the
 * canvas removes the selected job or step, and Alt+↑/↓ move the selected step. Nodes stay where
 * ELK put them. A need just written is drawn dashed until a picture of its texts is on screen.
 */

const NODE_TYPES = { workflow: WorkflowNode, job: JobNode };
const EDGE_TYPES = { needs: NeedsEdge };
const FIT = { padding: 0.1, maxZoom: 1 };
const ZOOM = { min: 0.2, max: 2 };
const HOVER_MS = 300;

const DESCRIPTION =
  'Up and down move between siblings, right and left follow needs, Enter goes in, Escape goes out, ' +
  'Space opens the step list.';
const ARIA: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default': DESCRIPTION,
  'node.a11yDescription.keyboardDisabled': DESCRIPTION,
  'edge.a11yDescription.default': 'Delete removes this need.',
};

/** The props that never change: a read view, single selection, our keys, our pan on focus and double-click. */
const FIXED = {
  nodeTypes: NODE_TYPES,
  edgeTypes: EDGE_TYPES,
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: true,
  nodesFocusable: true,
  edgesFocusable: false,
  autoPanOnNodeFocus: false,
  zoomOnDoubleClick: false,
  minZoom: ZOOM.min,
  maxZoom: ZOOM.max,
  panOnScroll: true,
  selectionOnDrag: false,
  selectionKeyCode: null,
  multiSelectionKeyCode: null,
  panActivationKeyCode: null,
  deleteKeyCode: null,
  elevateNodesOnSelect: true,
  ariaLabelConfig: ARIA,
} as const;

/** What edit mode changes for the workflow being edited: its jobs connect, its edges take the focus. */
const EDITING = {
  nodesConnectable: true,
  edgesFocusable: true,
  edgesReconnectable: false,
} as const;

const WAITING: Record<SessionState['project']['status'], string> = {
  idle: 'Laying out the graph…',
  loading: 'Loading the files…',
  ready: 'Laying out the graph…',
  error: 'No plan.',
};

/** Per session, the viewport its picture was last left at, kept while the canvas is unmounted. */
const memory = new WeakMap<SessionStore, ViewMemory>();
/** Per session, the last change whose flash has played, so a picture mounted again does not play it twice. */
const flashed = new WeakMap<SessionStore, number>();

export function Canvas() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}

/** What stays while the canvas is mounted: the viewport commands. */
function Flow() {
  const graph = useSession((s) => s.graph);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const rf = useReactFlow<FlowNode, NeedsFlowEdge>();
  useViewportCommands(rf, graphRef);
  usePaintedMark(graph?.for.files);
  useFitWhenRootsChange(graph);
  useFitWhenPaneToggles(rf);
  // A new source is a new picture: it mounts afresh and is fitted. Neither an edit of its texts nor the project a
  // restart numbers anew is one: the picture stays mounted, where the author left it.
  return graph ? <Picture key={graph.for.epoch} graph={graph} graphRef={graphRef} /> : <Waiting />;
}

/** The committed picture with the selection, the hovered node, a hovered unknown and the last change's flash on it. */
function Picture({ graph, graphRef }: { graph: GraphState; graphRef: RefObject<GraphState | undefined> }) {
  const { store } = useApp();
  const selected = useSession(selectedNode);
  const stale = useSession((s) => s.staleShown);
  const colorMode = useColorMode();
  const hover = useHover();
  const wrapper = useRef<HTMLDivElement>(null);
  const placed = useRef<NodeId>(undefined);
  const act = useMemo(() => cardActions(store), [store]);
  const { editing, hot, pending, edit } = useBuilder(store, graph);
  const flow = useFlow(store, graph, { selected, hovered: hover.id, editing, hotEdge: hot.id, pending });
  const start = useStartView(store, graph.for.epoch);
  const onKeyDown = useCanvasKeys(store, { wrapper, placed }, graphRef, selected, editing !== undefined);
  const onCardFocus = useCardFocus(store, graphRef, placed);
  const onDoubleClick = useDoubleClickZoom();
  const onNodeClick: NodeMouseHandler<FlowNode> = (_, node) => act.select(node.id);
  return (
    <div
      ref={wrapper}
      className="sc-canvas"
      data-stale={stale || undefined}
      onKeyDown={onKeyDown}
      onFocus={hot.focusIn(onCardFocus)}
      onBlur={hot.blur}
      onDoubleClick={onDoubleClick}
    >
      <ReactFlow<FlowNode, NeedsFlowEdge>
        {...FIXED}
        {...edit}
        nodes={flow.nodes}
        edges={flow.edges}
        colorMode={colorMode}
        defaultViewport={start.view.viewport}
        onMove={start.onMove}
        onNodeClick={onNodeClick}
        onPaneClick={act.selectFocus}
        onNodeMouseEnter={hover.enter}
        onNodeMouseLeave={hover.leave}
        onEdgeMouseEnter={hot.enter}
        onEdgeMouseLeave={hot.leave}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} fitViewOptions={FIT} />
      </ReactFlow>
    </div>
  );
}

/** What the builder adds to the picture (synthesis § 4.5): what it edits, its hot edge, its pending needs, its props. */
function useBuilder(store: SessionStore, graph: GraphState) {
  const editing = useEditing(store, graph);
  const hot = useHotEdge(graph);
  const pending = usePendingEdges(store, graph.for.files);
  const edit = useEditProps(store, editing);
  return { editing, hot, pending, edit };
}

/**
 * The depth-0 workflow edit mode is editing, when the picture draws it and the edit runtime answers its gestures: until
 * its chunk is in, the cards offer no handle, ✕ or + that would do nothing.
 */
function useEditing(store: SessionStore, graph: GraphState): NodeId | undefined {
  const focus = useSession((s) => (s.edit.on ? s.focus : undefined));
  const watch = useCallback((changed: () => void) => gestures.watch(store, changed), [store]);
  const ready = useSyncExternalStore(watch, () => gestures.of(store) !== undefined);
  const scope = focus === undefined || !ready ? undefined : graph.model.scopes[focus];
  return scope && scope.caller === undefined ? scope.id : undefined;
}

/** How long an edge stays hot after the pointer leaves it: time to reach its ✕, which then holds itself by hover. */
const COOL_MS = 400;

/**
 * The edge that shows its ✕: the one under the pointer, else the one with the focus. An edge removed while it has the
 * focus fires no blur, so the focus is read again whenever the picture changes.
 */
function useHotEdge(graph: GraphState) {
  const [pointer, setPointer] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => setFocused(edgeIdOf(document.activeElement)), [graph]);
  return useMemo(() => {
    const enter: EdgeMouseHandler<NeedsFlowEdge> = (_, edge) => {
      clearTimeout(timer.current);
      setPointer(edge.id);
    };
    const leave: EdgeMouseHandler<NeedsFlowEdge> = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setPointer(undefined), COOL_MS);
    };
    return {
      id: pointer ?? focused,
      enter,
      leave,
      /** The canvas's focus handler, with the focused edge read first. */
      focusIn:
        (then: (e: FocusEvent<HTMLDivElement>) => void) =>
        (e: FocusEvent<HTMLDivElement>): void => {
          setFocused(edgeIdOf(e.target));
          then(e);
        },
      blur: (e: FocusEvent<HTMLDivElement>): void => {
        if (edgeIdOf(e.target) !== undefined) setFocused(undefined);
      },
    };
  }, [pointer, focused]);
}

/** The needs written and not drawn yet; a picture of their texts or newer ones settles them. */
function usePendingEdges(store: SessionStore, files: number) {
  const subscribe = useCallback((changed: () => void) => pendingEdges.subscribe(store, changed), [store]);
  const pending = useSyncExternalStore(subscribe, () => pendingEdges.of(store));
  useEffect(() => pendingEdges.settle(store, files), [store, files]);
  return pending;
}

/**
 * What edit mode gives the picture of the workflow being edited: connectable jobs, focusable edges, and an edge that
 * takes the pointer (React Flow leaves an edge nothing clicks inert), a click selecting the job whose need it is.
 */
function useEditProps(store: SessionStore, editing: NodeId | undefined) {
  const connect = useConnect(store);
  return useMemo(() => {
    if (editing === undefined) return {};
    const onEdgeClick: EdgeMouseHandler<NeedsFlowEdge> = (_, edge) => cardActions(store).select(edge.target);
    return { ...EDITING, ...connect, onEdgeClick };
  }, [store, editing, connect]);
}

/**
 * A drag between two handles, as the edit runtime answers it: whether it may end where it is, the need it writes, and
 * for a drop the runtime refused, the reason it gives (a loop's sentence) in the status line.
 */
function useConnect(store: SessionStore) {
  return useMemo(() => {
    const onConnectEnd: OnConnectEnd = (_, state) => {
      if (state.isValid !== false || !state.toNode || !state.fromNode || !state.fromHandle) return;
      const from = state.fromHandle.type === 'source';
      const [source, target] = from ? [state.fromNode, state.toNode] : [state.toNode, state.fromNode];
      gestures.of(store)?.connect(source.id, target.id);
    };
    return {
      isValidConnection: (c: Connection | NeedsFlowEdge): boolean =>
        gestures.of(store)?.canConnect(c.source, c.target) ?? false,
      onConnect: (c: Connection): void => gestures.of(store)?.connect(c.source, c.target),
      onConnectEnd,
    };
  }, [store]);
}

/**
 * Fits the picture once when the workflows it draws change within an epoch: edit mode narrowing it to the focused
 * workflow, or widening it again, or Hide untriggered. The workflow the author looks at would otherwise move out
 * from under the viewport, which keeps its transform.
 */
function useFitWhenRootsChange(graph: GraphState | undefined): void {
  const roots = graph?.model.roots.join('\n');
  const epoch = graph?.for.epoch;
  const last = useRef<{ epoch: number; roots: string }>(undefined);
  useEffect(() => {
    if (roots === undefined || epoch === undefined) return undefined;
    const before = last.current;
    last.current = { epoch, roots };
    if (!before || before.epoch !== epoch || before.roots === roots) return undefined;
    const frame = requestAnimationFrame(() => viewport.fit());
    return () => cancelAnimationFrame(frame);
  }, [roots, epoch]);
}

/**
 * Fits the picture when the YAML pane opens or closes under it (`\`, its bar, a `file:line` link, entering edit mode),
 * without animation, as the pane itself appears: the viewport keeps its transform, so a picture fitted to the taller
 * canvas would run on under the pane, and one fitted to the shorter canvas would sit small in the room it gave back.
 */
function useFitWhenPaneToggles(rf: ReactFlowInstance<FlowNode, NeedsFlowEdge>): void {
  const closed = useSession((s) => s.ui.prefs.collapsed.yaml);
  const last = useRef(closed);
  useEffect(() => {
    if (last.current === closed) return undefined;
    last.current = closed;
    const frame = requestAnimationFrame(() => void rf.fitView(FIT));
    return () => cancelAnimationFrame(frame);
  }, [rf, closed]);
}

/** Marks the frame after a picture of new texts is drawn (`lib/marks.ts`), for the latency gate. */
function usePaintedMark(files: number | undefined): void {
  useEffect(() => {
    if (files === undefined) return undefined;
    const frame = requestAnimationFrame(() => markEdit('edit:painted', files));
    return () => cancelAnimationFrame(frame);
  }, [files]);
}

function Waiting() {
  const project = useSession((s) => s.project.status);
  return <p className="p-4 text-muted">{WAITING[project]}</p>;
}

/**
 * The flow for the picture, with the cards a hovered unknown lights and the last change's flash on it, each node and
 * edge that did not change kept as the object it was.
 */
function useFlow(
  store: SessionStore,
  graph: GraphState,
  { selected, hovered, editing, hotEdge, pending }: Omit<FlowView, 'lit' | 'flash'>,
): Flow {
  const lit = useLit(graph.model);
  const flash = useFlash(store, graph);
  const last = useRef<Flow>(undefined);
  return useMemo(() => {
    const view = { selected, hovered, lit, flash, editing, hotEdge, pending };
    last.current = keepUnchanged(last.current, toFlow(graph.model, graph.layout, view));
    return last.current;
  }, [graph, selected, hovered, lit, flash, editing, hotEdge, pending]);
}

/** The cards the unknown hovered in the Unknowns tab lights, while one is. */
function useLit(model: GraphModel): ReadonlySet<NodeId> | undefined {
  const hovered = useSession((s) => s.hoveredUnknown);
  const plan = useSession((s) => s.plan?.plan);
  return useMemo(() => litCards(model, plan, hovered), [model, plan, hovered]);
}

/**
 * The last change's flash while the picture shows the plan that answered it, until it has played: after FLASH_MS,
 * or RING_MS when it rings an added card, it is taken off the cards, so a card mounted later (a callee opened, the
 * picture mounted again) does not play it.
 */
function useFlash(store: SessionStore, graph: GraphState): Flash | undefined {
  const change = useSession((s) => s.change);
  const plan = useSession((s) => s.plan);
  const flash = useMemo(() => flashOf(change, plan, graph), [change, plan, graph]);
  const [, played] = useState<number>();
  const seq = flash?.seq;
  const ms = flash?.ring.size ? RING_MS : FLASH_MS;
  useEffect(() => {
    if (seq === undefined || flashed.get(store) === seq) return undefined;
    const timer = setTimeout(() => {
      flashed.set(store, seq);
      played(seq);
    }, ms);
    return () => clearTimeout(timer);
  }, [store, seq, ms]);
  return flash && flashed.get(store) !== flash.seq ? flash : undefined;
}

/** No animation for an author who asked for less motion; 200 ms otherwise. */
const duration = (): number => (reducedMotion() ? 0 : 200);

/**
 * Where this mount starts (view.ts): fitted, without animation, or where the picture was left. The fit is asked for
 * by an effect until it has run, so StrictMode's second mount, whose reset drops a fit React Flow had queued, asks
 * again. Moves are kept once the start is done, so a picture unmounted before its fit is fitted next time.
 */
function useStartView(store: SessionStore, epoch: number): { view: MountView; onMove: OnMove } {
  const rf = useReactFlow<FlowNode, NeedsFlowEdge>();
  const [view] = useState(() => mountView(memory.get(store), epoch));
  const started = useRef(!view.fit);
  useEffect(() => {
    if (started.current) return;
    void rf.fitView(FIT).then(() => {
      started.current = true;
      memory.set(store, { epoch, viewport: rf.getViewport() });
    });
  }, [rf, store, epoch]);
  const onMove = useCallback<OnMove>(
    (_, at) => {
      if (started.current) memory.set(store, { epoch, viewport: at });
    },
    [store, epoch],
  );
  return { view, onMove };
}

/** Registers fit, centre and 100 % for the shortcuts and the panels while the canvas is mounted. */
function useViewportCommands(
  rf: ReactFlowInstance<FlowNode, NeedsFlowEdge>,
  graph: RefObject<GraphState | undefined>,
): void {
  const flowStore = useStoreApi<FlowNode, NeedsFlowEdge>();
  useEffect(() => {
    const centre = (id: NodeId): void => {
      const card = graph.current && cardOf(graph.current.model, id);
      const node = card === undefined ? undefined : rf.getInternalNode(card);
      if (!node) return;
      const rect = {
        ...node.internals.positionAbsolute,
        width: node.measured.width ?? node.width ?? 0,
        height: node.measured.height ?? node.height ?? 0,
      };
      const { transform, width, height } = flowStore.getState();
      if (!outsideView(rect, transform, { width, height })) return;
      const at = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      void rf.setCenter(at.x, at.y, { zoom: transform[2], duration: duration() });
    };
    const commands: ViewportCommands = {
      fit: () => void rf.fitView({ ...FIT, duration: duration() }),
      actualSize: () => void rf.zoomTo(1, { duration: duration() }),
      centre,
    };
    return viewport.register(commands);
  }, [rf, graph, flowStore]);
}

/** The wrapper, and the card the canvas keys last gave the focus to. */
interface FocusRefs {
  wrapper: RefObject<HTMLDivElement | null>;
  placed: RefObject<NodeId | undefined>;
}

/**
 * The canvas keys on the wrapper: `navigate()` answers, with the last needs edge remembered for Alt to cycle, and the
 * card the keys are moving the focus to until it has it. In edit mode the edit keys go first: Delete removes the
 * focused edge's need or the selection, Alt+↑/↓ move a selected step (and are ↑/↓ for anything else).
 */
function useCanvasKeys(
  store: SessionStore,
  refs: FocusRefs,
  graph: RefObject<GraphState | undefined>,
  selected: NodeId | undefined,
  editing: boolean,
): (e: KeyboardEvent<HTMLDivElement>) => void {
  const moving = useRef<NodeId>(undefined);
  const effects = useNavEffects(store, refs, graph, moving);
  const [navigate] = useState(createNavigator);
  return (e) => {
    if (editing && runEditKey(store, e, graph.current, selected)) {
      e.preventDefault();
      return;
    }
    const action = keyAction(e, navigate, selected, graph.current, moving.current);
    if (!action) return;
    e.preventDefault();
    runNav(action, effects);
  };
}

/** An edit key on the canvas, run through the edit runtime: false when it is none, or nothing took it. */
function runEditKey(
  store: SessionStore,
  e: KeyboardEvent<HTMLDivElement>,
  graph: GraphState | undefined,
  selected: NodeId | undefined,
): boolean {
  const key = editKey(e, graph?.model, selected);
  const edit = key && gestures.of(store);
  if (!key || !edit) return false;
  if (key === 'remove') return edit.remove();
  if (key === 'up' || key === 'down') return edit.move(key === 'up' ? -1 : 1);
  edit.disconnect(key.source, key.target);
  return true;
}

/**
 * What the canvas keys do: a keyboard selection also brings its card into view and gives it the focus in the next
 * frame. Until then the card is `moving`, so a key pressed meanwhile goes on from the selection.
 */
function useNavEffects(
  store: SessionStore,
  { wrapper, placed }: FocusRefs,
  graph: RefObject<GraphState | undefined>,
  moving: RefObject<NodeId | undefined>,
): NavEffects {
  return useMemo(() => {
    const act = cardActions(store);
    const focusCard = (id: NodeId): void => {
      const card = graph.current && cardOf(graph.current.model, id);
      if (card === undefined) return;
      moving.current = card;
      requestAnimationFrame(() => {
        if (moving.current === card) moving.current = undefined;
        const el = wrapper.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(card)}"]`,
        );
        if (!el || el === document.activeElement) return;
        placed.current = card;
        el.focus({ preventScroll: true });
      });
    };
    return {
      select: (id) => {
        if (id === undefined) return act.selectFocus();
        act.select(id);
        viewport.centre(id);
        focusCard(id);
      },
      toggle: act.toggleExpanded,
      fit: viewport.fit,
      centre: viewport.centre,
      actualSize: viewport.actualSize,
      leave: () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && wrapper.current?.contains(active)) active.blur();
      },
    };
  }, [store, wrapper, placed, moving, graph]);
}

/** Focus on a card from anywhere but the canvas keys selects it, and from the keyboard brings it into view. */
function useCardFocus(
  store: SessionStore,
  graph: RefObject<GraphState | undefined>,
  placed: RefObject<NodeId | undefined>,
): (e: FocusEvent<HTMLDivElement>) => void {
  return useCallback(
    (e) => {
      const card = nodeIdOf(e.target);
      const model = graph.current?.model;
      if (card === undefined || !model) return;
      const cause = {
        keys: placed.current === card,
        keyboard: e.target instanceof Element && e.target.matches(':focus-visible'),
      };
      placed.current = undefined;
      const asks = cardFocus(card, selectedNode(store.getState()), model, cause);
      if (asks.select !== undefined) cardActions(store).select(asks.select);
      if (asks.centre !== undefined) viewport.centre(asks.centre);
    },
    [store, graph, placed],
  );
}

/** A double-click on the picture zooms about the pointer in the canvas's time (view.ts), not d3-zoom's 250 ms. */
function useDoubleClickZoom(): (e: MouseEvent<HTMLDivElement>) => void {
  const rf = useReactFlow<FlowNode, NeedsFlowEdge>();
  const flowStore = useStoreApi<FlowNode, NeedsFlowEdge>();
  return useCallback(
    (e) => {
      const pane = flowStore.getState().domNode;
      if (!pane || !(e.target instanceof Element) || !e.target.closest('.react-flow__renderer')) return;
      const box = pane.getBoundingClientRect();
      const pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
      void rf.setViewport(doubleClickZoom(rf.getViewport(), pointer, e.shiftKey, ZOOM), {
        duration: duration(),
      });
    },
    [rf, flowStore],
  );
}

/** The hover card opens 300 ms after the pointer settles on a node and closes as it leaves. */
function useHover(): {
  id: NodeId | undefined;
  enter: NodeMouseHandler<FlowNode>;
  leave: NodeMouseHandler<FlowNode>;
} {
  const [id, set] = useState<NodeId>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const handlers = useMemo(
    () => ({
      enter: ((_, node) => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => set(node.id), HOVER_MS);
      }) satisfies NodeMouseHandler<FlowNode>,
      leave: (() => {
        clearTimeout(timer.current);
        set(undefined);
      }) satisfies NodeMouseHandler<FlowNode>,
    }),
    [],
  );
  return { id, ...handlers };
}

/** React Flow's colour mode follows the page's resolved `data-theme`, which app/theme.ts keeps. */
function useColorMode(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeTheme, readTheme, () => 'light');
}

const readTheme = (): 'light' | 'dark' =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

function subscribeTheme(changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
