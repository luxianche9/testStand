import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // React reports caught renderer failures through its root error hooks. The
    // boundary deliberately avoids an additional console write so one failure
    // does not become a duplicate renderer error report.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return this.props.fallback ?? (
        <section className="feature-error" role="alert">
          <strong>此功能暂时无法显示</strong>
          <span>请切换页面后重试。</span>
        </section>
      );
    }
    return this.props.children;
  }
}
