import type { HardwareOccupancyRequest } from "@testforge/contracts/occupancy";
import { Button } from "../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "../shared/ui/dialog";
import { occupancyHardwareLabel } from "./MailboxDropdown.js";

export function OccupancyAlertModal({ requests, busyRequestId, onAction }: {
  requests: HardwareOccupancyRequest[];
  busyRequestId: string | undefined;
  onAction: (id: string, action: "acquire" | "reject") => void;
}) {
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent>
        <DialogHeader title="AI 请求人工占用硬件" />
        <DialogBody>
          <div className="grid gap-2.5">
            {requests.map((request) => (
              <div key={request.occupancyRequestId} className="grid gap-1 rounded-xl bg-secondary/40 px-3 py-2.5 shadow-sm ring-1 ring-border">
                <strong className="text-sm">{occupancyHardwareLabel(request, [])}</strong>
                <small className="text-xs text-muted-foreground">{request.reason || "AI 请求在操作前占用这些硬件。"}</small>
                {request.message && <small className="text-xs text-muted-foreground">{request.message}</small>}
                <span className="mt-1.5 flex gap-1.5">
                  <Button size="xs" disabled={busyRequestId === request.occupancyRequestId} onClick={() => onAction(request.occupancyRequestId, "acquire")}>占用全部</Button>
                  <Button size="xs" variant="outline" disabled={busyRequestId === request.occupancyRequestId} onClick={() => onAction(request.occupancyRequestId, "reject")}>拒绝</Button>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 mb-0 text-xs text-muted-foreground">该操作必须由人类点击。任一硬件占用失败时，只回滚本次新获得的租约。</p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
