import { type DragEvent, type ReactNode, useState } from 'react';
import { Canvas } from '../graph/Canvas';
import { OutlineTree } from '../panels/OutlineTree';
import { restoreDefault } from '../state/url-sync';
import { TextView } from '../text/TextView';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { useApp, useSession } from './providers';
import { ScenarioForm } from './ScenarioForm';
import { shownView, useNarrow } from './shortcuts';
import { StatusBar } from './StatusBar';
import { Toaster } from './Toaster';
import { TopBar } from './TopBar';

/**
 * The screen: top bar, banner, the scenario and the outline beside the plan, the status line. Drop a folder anywhere.
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
      {hasFiles ? (
        <PlanBoundary>
          <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_1fr]">
            <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto border-border border-b bg-chrome p-4 md:border-r md:border-b-0">
              <ScenarioForm />
              <OutlineTree />
            </aside>
            <PlanView />
          </main>
        </PlanBoundary>
      ) : (
        <EmptyState />
      )}
      <StatusBar />
      <Toaster />
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

/** The run graph, or the plan as text: the author's pick, and the text below 1024 px, where the graph has no room. */
function PlanView() {
  const view = useSession((s) => s.ui.view);
  const narrow = useNarrow();
  return shownView(view, narrow) === 'graph' ? (
    <section className="min-h-0 overflow-hidden" aria-label="The run graph">
      <Canvas />
    </section>
  ) : (
    <section className="min-h-0 overflow-auto">
      <TextView />
    </section>
  );
}

/** The boundary tries again on a new scenario or new files, and its button puts back the page's own scenario. */
function PlanBoundary({ children }: { children: ReactNode }) {
  const { store } = useApp();
  const scenario = useSession((s) => s.scenario);
  const files = useSession((s) => s.files.version);
  return (
    <ErrorBoundary resetKeys={[scenario, files]} onReset={() => restoreDefault(store)}>
      {children}
    </ErrorBoundary>
  );
}
