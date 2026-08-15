import { Component, type ErrorInfo, type ReactNode } from "react";
import { Btn } from "./ui.js";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onReload?: () => void;
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

  private retry = () => this.setState({ failed: false });

  private reload = () => {
    if (this.props.onReload) this.props.onReload();
    else window.location.reload();
  };

  render(): ReactNode {
    if (this.state.failed) {
      return this.props.fallback ?? (
        <section className="feature-error" role="alert">
          <strong>此功能暂时无法显示</strong>
          <span>页面资源可能已更新，或该功能发生了临时错误。</span>
          <div className="feature-error-actions">
            <Btn onClick={this.retry}>重试</Btn>
            <Btn variant="primary" onClick={this.reload}>重新加载应用</Btn>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
