import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Button, EmptyState } from "../ui";

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
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ?? (
      <section role="alert" className="flex min-h-0 flex-1">
        <EmptyState
          icon={<TriangleAlertIcon />}
          title="此功能暂时无法显示"
          description="页面资源可能已更新，或该功能发生了临时错误。"
          action={<>
            <Button onClick={this.retry}>重试</Button>
            <Button variant="primary" onClick={this.reload}>重新加载应用</Button>
          </>}
          className="flex-1"
        />
      </section>
    );
  }
}
