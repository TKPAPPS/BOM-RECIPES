import React from 'react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
          <h2>Something went wrong</h2>
          <pre style={{ color: 'red', whiteSpace: 'pre-wrap' }}>{this.state.message}</pre>
          <button onClick={() => this.setState({ hasError: false, message: '' })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
