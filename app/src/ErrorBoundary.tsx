import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last thing between a thrown error and a white window.
 *
 * It says what happened and that the file on disk is untouched, which is the
 * one thing an operator wants to know when a viewer falls over mid-clean. The
 * stack is selectable so it can be pasted into an issue.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui]", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <h2>Snapir Viewer stopped</h2>
        <p>
          Something in the interface failed. Nothing was written: the scan on
          disk is exactly as it was.
        </p>
        <pre>{error.message}{error.stack ? `\n\n${error.stack}` : ""}</pre>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
