import {
  Component,
  type CSSProperties,
  type DragEvent,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from 'react';
import { Canvas } from '../graph/Canvas';
import { OutlineTree } from '../panels/OutlineTree';
import { Panels } from '../panels/Panels';
import { restoreDefault } from '../state/url-sync';
import { TextView } from '../text/TextView';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { ReplacePrompt } from './ReplaceDialog';
import { RestoreConflicts } from './RestoreConflicts';
import { useApp, useSession } from './providers';
import { ScenarioForm } from './ScenarioForm';
import { shownView, togglePaneKeepingFocus, useNarrow } from './shortcuts';
import { StatusBar } from './StatusBar';
import { Toaster } from './Toaster';
import { TopBar } from './TopBar';

/** CodeMirror is a chunk of its own, fetched the first time the pane opens. */
const YamlPane = lazy(() => import('../yaml/YamlPane').then((m) => ({ default: m.YamlPane })));

/**
 * The screen: top bar, banner, the scenario and the outline, the plan with the YAML pane under it, the right panel,
 * the status line. Drop a folder anywhere.
 * A render error in the scenario, the outline or the plan stays inside them, so the top bar and the source menu keep
 * working.
 */
export function SimulateView() {
  const { sources } = useApp();
  const hasFiles = useSession((s) => Object.keys(s.files.byPath).length > 0);
  const [dragging, setDragging] = useState(false);

  const onDragOver = (e: DragEvent): void => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    void sources.drop(e.dataTransfer);
  };

  return (
    <div
      className="relative flex h-full flex-col bg-bg text-text"
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <TopBar />
      <ErrorBanner />
      <RestoreConflicts />
      {hasFiles ? (
        <PlanBoundary>
          <Panes />
        </PlanBoundary>
      ) : (
        <EmptyState />
      )}
      <StatusBar />
      <Toaster />
      <ReplacePrompt />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-4 border-accent border-dashed bg-bg/80">
          <p className="rounded bg-surface px-4 py-2 font-medium text-lg">
            Drop a repository folder or workflow files
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The scenario and the outline on the left, the plan in the middle with the YAML pane docked under it, the panel on
 * the right. `[`, `]` and `\` close and open them (app/shortcuts.ts, which reads `data-pane`); the choice is a
 * preference. Below 1024 px the right panel goes under the plan, with the scenario column beside both; below 768 px
 * everything stacks at its own height and the page scrolls.
 */
function Panes() {
  const { store } = useApp();
  const collapsed = useSession((s) => s.ui.prefs.collapsed);
  const columns = {
    '--left': collapsed.left ? '0px' : '320px',
    '--right': collapsed.right ? '0px' : '360px',
  } as CSSProperties;
  return (
    <main
      style={columns}
      className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 overflow-y-auto md:auto-rows-auto md:grid-cols-[var(--left)_minmax(0,1fr)] md:overflow-hidden lg:grid-cols-[var(--left)_minmax(0,1fr)_var(--right)]"
    >
      <aside
        hidden={collapsed.left}
        data-pane="left"
        aria-label="Scenario and outline"
        className={`relative flex min-h-0 flex-col gap-6 overflow-y-auto border-border border-b bg-chrome p-4 md:border-r md:border-b-0 ${collapsed.right ? '' : 'md:row-span-2 lg:row-span-1'}`}
      >
        <ScenarioForm />
        <OutlineTree />
      </aside>
      <div className="flex min-h-0 flex-col md:col-start-2">
        <PlanView />
        {!collapsed.yaml && (
          <section
            data-pane="yaml"
            aria-label="Workflow source"
            className="flex h-[60vh] min-h-48 shrink-0 flex-col border-border border-t md:h-[40%]"
          >
            <EditorBoundary onClose={() => togglePaneKeepingFocus(store.getState(), 'yaml')}>
              <Suspense fallback={<p className="p-3 text-muted text-xs">loading the editor…</p>}>
                <YamlPane />
              </Suspense>
            </EditorBoundary>
          </section>
        )}
      </div>
      <aside
        hidden={collapsed.right}
        data-pane="right"
        aria-label="Plan details"
        className="flex min-h-0 flex-col border-border border-t bg-surface md:col-start-2 lg:col-start-3 lg:row-start-1 lg:border-t-0 lg:border-l"
      >
        <Panels />
      </aside>
    </main>
  );
}

/**
 * The run graph, or the plan as text: the author's pick, and the text below 1024 px, where the graph has no room.
 * `data-plan` is where the focus goes when the pane that held it closes.
 */
function PlanView() {
  const view = useSession((s) => s.ui.view);
  const narrow = useNarrow();
  return shownView(view, narrow) === 'graph' ? (
    <section data-plan tabIndex={-1} className="min-h-0 flex-1 overflow-hidden" aria-label="The run graph">
      <Canvas />
    </section>
  ) : (
    <section
      data-plan
      tabIndex={-1}
      className="min-h-0 overflow-auto md:flex-1"
      aria-label="The plan as text"
    >
      <TextView />
    </section>
  );
}

/**
 * The YAML pane's own boundary: an editor chunk that could not load (a redeploy while the page was open, or no
 * network) or an editor that threw stays inside the pane, and the scenario and the plan stay as they are. React keeps
 * a failed lazy import, so the ways out are closing the pane and reloading the page.
 */
class EditorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 bg-surface p-3 text-sm">
        <p className="font-medium">The editor could not load.</p>
        <p className="max-w-full break-words font-mono text-muted text-xs">{error.message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            className={BUTTON}
            aria-label="Close the workflow source"
            onClick={this.props.onClose}
          >
            Close
          </button>
          <button type="button" className={BUTTON} onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}

const BUTTON = 'rounded border border-border bg-surface px-2 py-0.5 text-xs hover:border-border-strong';

/**
 * The boundary tries again whenever something its children render from changes: the scenario and the files, and what
 * reaches the store after them (the outline, the focus, the worker's refusal, the plan, the selection, the committed
 * picture, the canvas's own state and the view), so an error the committed plan caused goes once the next plan
 * commits. Its button puts back the page's own scenario.
 */
function PlanBoundary({ children }: { children: ReactNode }) {
  const { store } = useApp();
  const scenario = useSession((s) => s.scenario);
  const files = useSession((s) => s.files.version);
  const outline = useSession((s) => s.project.outline);
  const focus = useSession((s) => s.focus);
  const error = useSession((s) => s.error);
  const plan = useSession((s) => s.plan);
  const sel = useSession((s) => s.sel);
  const graph = useSession((s) => s.graph);
  const ui = useSession((s) => s.ui);
  return (
    <ErrorBoundary
      resetKeys={[scenario, files, outline, focus, error, plan, sel, graph, ui]}
      onReset={() => restoreDefault(store)}
    >
      {children}
    </ErrorBoundary>
  );
}
