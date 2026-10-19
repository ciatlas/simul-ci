import { Component, type ReactNode } from 'react';

/**
 * The route's error boundary around the scenario form and the plan: a render error there shows its message and a
 * way back to the page's own scenario, while the top bar and the source menu outside it stay usable.
 */

interface Props {
  children: ReactNode;
  /** The children are tried again once one of these changes (a new scenario, new files). */
  resetKeys: readonly unknown[];
  /** Puts back the page's own scenario. */
  onReset: () => void;
}

interface State {
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    if (error instanceof Error) return { error };
    return {
      error: new Error(typeof error === 'string' ? error : 'the view threw something that is not an Error'),
    };
  }

  override componentDidUpdate(prev: Props, prevState: State): void {
    const changed = prev.resetKeys.some((key, i) => !Object.is(key, this.props.resetKeys[i]));
    if (this.state.error && prevState.error && changed) this.setState({ error: undefined });
  }

  private readonly reset = (): void => {
    this.props.onReset();
    this.setState({ error: undefined });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-0 flex-1 flex-col items-start gap-2 p-4 text-sm">
        <p className="font-medium">The page could not show this scenario.</p>
        <p className="max-w-full break-words font-mono text-muted text-xs">{error.message}</p>
        <button
          type="button"
          className="rounded border border-border bg-surface px-2 py-0.5 text-xs"
          onClick={this.reset}
        >
          Put back the default scenario
        </button>
      </div>
    );
  }
}
