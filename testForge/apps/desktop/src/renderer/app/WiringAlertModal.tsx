import type { WiringTask } from "@testforge/contracts/wiring";
import { Button } from "../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../shared/ui/dialog";
import { pinCountText, taskTitle } from "../features/wiring/wiring-model.js";

export function WiringAlertModal({ tasks, hardware, onGoWiring }: {
  tasks: WiringTask[];
  hardware: Parameters<typeof taskTitle>[1];
  onGoWiring: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onGoWiring(); }}>
      <DialogContent>
        <DialogHeader title="AI 请求人工接线" />
        <DialogBody>
          <div className="grid gap-2.5">
            {tasks.map((task) => (
              <div key={task.wiringTaskId} className="grid gap-1 rounded-xl bg-secondary/40 px-3 py-2.5 shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
                <strong className="text-sm">{taskTitle(task, hardware)}</strong>
                <small className="text-xs text-muted-foreground">{pinCountText(task)}</small>
                {task.message && <small className="text-xs text-muted-foreground">{task.message}</small>}
                {task.warnings.map((warning) => <small key={warning} className="text-xs text-warning">⚠ {warning}</small>)}
              </div>
            ))}
          </div>
          <p className="mt-3 mb-0 text-xs text-muted-foreground">请在工位接线页确认完成后，AI 流程才会继续。</p>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onGoWiring}>前往处理</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
