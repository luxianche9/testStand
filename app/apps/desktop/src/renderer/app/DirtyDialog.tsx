import type { PendingAction } from "../lib/hooks/useDirtyGuard.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter } from "../ui";

export function DirtyDialog({ pending, onContinue, onCancel }: {
  pending: PendingAction | undefined;
  onContinue: (saveFirst: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent title="保存项目修改" size="sm">
        <DialogBody className="text-fg-2">当前项目有未保存的修改。要在{pending?.label}前保存吗？</DialogBody>
        <DialogFooter>
          <Button onClick={onCancel}>取消</Button>
          <Button variant="danger" onClick={() => onContinue(false)}>放弃修改</Button>
          <Button variant="primary" onClick={() => onContinue(true)}>保存并继续</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
