import { type DragEvent, useState } from 'react';
import { TextView } from '../text/TextView';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { useApp, useSession } from './providers';
import { ScenarioForm } from './ScenarioForm';
import { StatusBar } from './StatusBar';
import { Toaster } from './Toaster';
import { TopBar } from './TopBar';

/** The screen: top bar, banner, the scenario beside the plan, the status line. Drop a folder anywhere. */
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
        <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_1fr]">
          <aside className="min-h-0 overflow-y-auto border-border border-b bg-chrome p-4 md:border-r md:border-b-0">
            <ScenarioForm />
          </aside>
          <section className="min-h-0 overflow-auto">
            <TextView />
          </section>
        </main>
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
