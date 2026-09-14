import {
  type OpenCodePermissionRequest,
  type OpenCodePermissionResponse,
  useOpenCodeRuntimeExtras
} from "@assistant-ui/react-opencode";
import { CheckCircle2Icon, LoaderIcon, ShieldAlertIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../../shared/ui/index.js";

function replyLabel(reply: OpenCodePermissionResponse) {
  if (reply === "always") return "已始终允许";
  if (reply === "once") return "已允许一次";
  return "已拒绝";
}

export function OpenCodePermissionCard({
  request,
  state,
  reply
}: {
  request: OpenCodePermissionRequest;
  state: "pending" | "resolved";
  reply?: OpenCodePermissionResponse;
}) {
  const { replyToPermission } = useOpenCodeRuntimeExtras();
  const [submitting, setSubmitting] = useState<OpenCodePermissionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = state === "pending";
  const submit = async (next: OpenCodePermissionResponse) => {
    setSubmitting(next);
    setError(null);
    try { await replyToPermission(request.id, next); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交授权结果失败。");
      setSubmitting(null);
    }
  };
  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-amber-500/10 p-2 text-amber-700 dark:text-amber-400">
            {pending ? <ShieldAlertIcon className="size-4" /> : reply === "reject" ? <XCircleIcon className="size-4" /> : <CheckCircle2Icon className="size-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm">{pending ? "需要操作授权" : replyLabel(reply!)}</CardTitle>
            <CardDescription className="mt-1 text-xs">{request.title ?? `OpenCode 请求执行 ${request.toolName ?? request.permission}。`}</CardDescription>
          </div>
          <Badge variant={pending ? "secondary" : "outline"} className="max-w-28 truncate">{request.toolName ?? request.permission}</Badge>
        </div>
      </CardHeader>
      {(request.patterns.length > 0 || request.toolInput !== undefined) && (
        <CardContent className="space-y-3">
          {!!request.patterns.length && <div className="flex flex-wrap gap-2">{request.patterns.map((pattern) => <Badge key={pattern} variant="outline" className="max-w-full font-mono wrap-anywhere">{pattern}</Badge>)}</div>}
          {request.toolInput !== undefined && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(request.toolInput, null, 2)}</pre>}
        </CardContent>
      )}
      {pending && (
        <CardFooter className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void submit("once")} disabled={submitting !== null}>{submitting === "once" && <LoaderIcon className="size-4 animate-spin" />}允许一次</Button>
          <Button size="sm" variant="secondary" onClick={() => void submit("always")} disabled={submitting !== null}>{submitting === "always" && <LoaderIcon className="size-4 animate-spin" />}始终允许</Button>
          <Button size="sm" variant="outline" onClick={() => void submit("reject")} disabled={submitting !== null}>{submitting === "reject" && <LoaderIcon className="size-4 animate-spin" />}拒绝</Button>
          {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
        </CardFooter>
      )}
    </Card>
  );
}
