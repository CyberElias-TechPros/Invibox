import { Component, type ErrorInfo, type ReactNode } from "react";
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    console.error("Invibox could not render this screen. Reload to recover.");
  }
  render() {
    return this.state.failed ? (
      <main className="invite-error" role="alert">
        <h1>This screen could not load</h1>
        <p>
          Reload to retrieve the latest saved data. Unsaved edits may need to be
          entered again.
        </p>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload Invibox
        </button>
        <a href="/app">Return to your workspace</a>
      </main>
    ) : (
      this.props.children
    );
  }
}
