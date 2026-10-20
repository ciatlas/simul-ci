import type { NodeId } from '@simulci/engine';
import {
  type AriaLabelConfig,
  Background,
  BackgroundVariant,
  Controls,
  type NodeMouseHandler,
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
import type { SessionState, SessionStore } from '../state/store';
import { cardActions, selectedNode } from './card';
import { type ViewportCommands, viewport } from './commands';
import { NeedsEdge } from './edges/NeedsEdge';
import {
  cardFocus,
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
import { FLASH_MS, type Flash, flashOf, litCards, reducedMotion } from './highlight';
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
 * Shift and Meta select). The first picture of the files loaded is fitted once; after that the viewport moves only
 * when the author asks, and a picture mounted again opens where it was left. Every node stays mounted (the node
 * count is bounded by workflows and jobs, never legs or steps), so the card with the focus never leaves the page
 * under it. An unknown hovered in the Unknowns tab fades the cards it does not affect; the cards a pin changed flash
 * once. For an author who asked for less motion nothing on the canvas moves by itself: the viewport jumps, nothing
 * flashes, and index.css turns the recolour transitions off.
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

const WAITING: Record<SessionState['project']['status'], string> = {
  idle: 'Laying out the graph…',
  loading: 'Loading the files…',
  ready: 'Laying out the graph…',
  error: 'No plan.',
};

/** Per session, the viewport its picture was last left at, kept while the canvas is unmounted. */
const memory = new WeakMap<SessionStore, ViewMemory>();
/** Per session, the last pin whose flash has played, so a picture mounted again does not play it twice. */
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
  // New files are a new picture: it mounts afresh and is fitted. The project a restart numbers anew is not one.
  return graph ? <Picture key={graph.for.files} graph={graph} graphRef={graphRef} /> : <Waiting />;
}

/** The committed picture with the selection, the hovered node, a hovered unknown and the last pin's flash on it. */
function Picture({ graph, graphRef }: { graph: GraphState; graphRef: RefObject<GraphState | undefined> }) {
  const { store } = useApp();
  const selected = useSession(selectedNode);
  const stale = useSession((s) => s.stale);
  const colorMode = useColorMode();
  const [hovered, setHovered] = useState<NodeId>();
  const hover = useHover(setHovered);
  const wrapper = useRef<HTMLDivElement>(null);
  const placed = useRef<NodeId>(undefined);
  const act = useMemo(() => cardActions(store), [store]);
  const flow = useFlow(store, graph, { selected, hovered });
  const start = useStartView(store, graph.for.files);
  const onKeyDown = useCanvasKeys(store, { wrapper, placed }, graphRef, selected);
  const onFocus = useCardFocus(store, graphRef, placed);
  const onDoubleClick = useDoubleClickZoom();
  const onNodeClick: NodeMouseHandler<FlowNode> = (_, node) => act.select(node.id);
  return (
    <div
      ref={wrapper}
      className="sc-canvas"
      data-stale={stale || undefined}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onDoubleClick={onDoubleClick}
    >
      <ReactFlow<FlowNode, NeedsFlowEdge>
        {...FIXED}
        nodes={flow.nodes}
        edges={flow.edges}
        colorMode={colorMode}
        defaultViewport={start.view.viewport}
        onMove={start.onMove}
        onNodeClick={onNodeClick}
        onPaneClick={act.selectFocus}
        onNodeMouseEnter={hover.enter}
        onNodeMouseLeave={hover.leave}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} fitViewOptions={FIT} />
      </ReactFlow>
    </div>
  );
}

function Waiting() {
  const project = useSession((s) => s.project.status);
  return <p className="p-4 text-muted">{WAITING[project]}</p>;
}

/**
 * The flow for the picture, with the cards a hovered unknown lights and the last pin's flash on it, each node and
 * edge that did not change kept as the object it was.
 */
function useFlow(
  store: SessionStore,
  graph: GraphState,
  { selected, hovered }: Pick<FlowView, 'selected' | 'hovered'>,
): Flow {
  const lit = useLit(graph.model);
  const flash = useFlash(store, graph);
  const last = useRef<Flow>(undefined);
  return useMemo(() => {
    const view = { selected, hovered, lit, flash };
    last.current = keepUnchanged(last.current, toFlow(graph.model, graph.layout, view));
    return last.current;
  }, [graph, selected, hovered, lit, flash]);
}

/** The cards the unknown hovered in the Unknowns tab lights, while one is. */
function useLit(model: GraphModel): ReadonlySet<NodeId> | undefined {
  const hovered = useSession((s) => s.hoveredUnknown);
  const plan = useSession((s) => s.plan?.plan);
  return useMemo(() => litCards(model, plan, hovered), [model, plan, hovered]);
}

/**
 * The last pin's flash while the picture shows the plan that answered it, until it has played: after FLASH_MS it is
 * taken off the cards, so a card mounted later (a callee opened, the picture mounted again) does not play it.
 */
function useFlash(store: SessionStore, graph: GraphState): Flash | undefined {
  const pin = useSession((s) => s.pin);
  const plan = useSession((s) => s.plan);
  const flash = useMemo(() => flashOf(pin, plan, graph), [pin, plan, graph]);
  const [, played] = useState<number>();
  const seq = flash?.seq;
  useEffect(() => {
    if (seq === undefined || flashed.get(store) === seq) return undefined;
    const timer = setTimeout(() => {
      flashed.set(store, seq);
      played(seq);
    }, FLASH_MS);
    return () => clearTimeout(timer);
  }, [store, seq]);
  return flash && flashed.get(store) !== flash.seq ? flash : undefined;
}

/** No animation for an author who asked for less motion; 200 ms otherwise. */
const duration = (): number => (reducedMotion() ? 0 : 200);

/**
 * Where this mount starts (view.ts): fitted, without animation, or where the picture was left. The fit is asked for
 * by an effect until it has run, so StrictMode's second mount, whose reset drops a fit React Flow had queued, asks
 * again. Moves are kept once the start is done, so a picture unmounted before its fit is fitted next time.
 */
function useStartView(store: SessionStore, files: number): { view: MountView; onMove: OnMove } {
  const rf = useReactFlow<FlowNode, NeedsFlowEdge>();
  const [view] = useState(() => mountView(memory.get(store), files));
  const started = useRef(!view.fit);
  useEffect(() => {
    if (started.current) return;
    void rf.fitView(FIT).then(() => {
      started.current = true;
      memory.set(store, { files, viewport: rf.getViewport() });
    });
  }, [rf, store, files]);
  const onMove = useCallback<OnMove>(
    (_, at) => {
      if (started.current) memory.set(store, { files, viewport: at });
    },
    [store, files],
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
 * card the keys are moving the focus to until it has it.
 */
function useCanvasKeys(
  store: SessionStore,
  refs: FocusRefs,
  graph: RefObject<GraphState | undefined>,
  selected: NodeId | undefined,
): (e: KeyboardEvent<HTMLDivElement>) => void {
  const moving = useRef<NodeId>(undefined);
  const effects = useNavEffects(store, refs, graph, moving);
  const [navigate] = useState(createNavigator);
  return (e) => {
    const action = keyAction(e, navigate, selected, graph.current, moving.current);
    if (!action) return;
    e.preventDefault();
    runNav(action, effects);
  };
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
function useHover(set: (id: NodeId | undefined) => void): {
  enter: NodeMouseHandler<FlowNode>;
  leave: NodeMouseHandler<FlowNode>;
} {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useMemo(
    () => ({
      enter: (_, node) => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => set(node.id), HOVER_MS);
      },
      leave: () => {
        clearTimeout(timer.current);
        set(undefined);
      },
    }),
    [set],
  );
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
