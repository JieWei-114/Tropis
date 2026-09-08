import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="flex min-h-[300px] items-center justify-center p-8">
        <div className="flex max-w-[480px] flex-col items-center gap-3 rounded-[14px] border border-danger/30 bg-danger/10 px-10 py-8 text-center">
          <h3 className="m-0 text-base font-bold text-danger">
            Something went wrong
          </h3>
          <pre className="m-0 max-w-full rounded-md border border-border-soft bg-background px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-muted">
            {error.message}
          </pre>
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-edge/60 bg-raised px-4 py-[7px] text-[13px] font-medium whitespace-nowrap text-soft transition-opacity enabled:hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={this.reset}
          >
            ↺ Try again
          </button>
        </div>
      </div>
    );
  }
}
