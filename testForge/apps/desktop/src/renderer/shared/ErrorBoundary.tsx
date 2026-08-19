import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

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
        <section role="alert" className="grid min-h-0 flex-1 place-content-center justify-items-center gap-2 p-8 text-center text-muted-foreground">
          <strong className="text-base text-foreground">此功能暂时无法显示</strong>
          <span className="text-sm">页面资源可能已更新，或该功能发生了临时错误。</span>
          <div className="mt-2 flex gap-2">
            <Button variant="outline" onClick={this.retry}>重试</Button>
            <Button onClick={this.reload}>重新加载应用</Button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
