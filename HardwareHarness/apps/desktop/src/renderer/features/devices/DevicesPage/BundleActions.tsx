import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DeviceBundleKind } from "@hardwareharness/contracts/devices";
import { CircleAlertIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { errorMessage } from "../../../shared/errors.js";
import { Button } from "../../../shared/ui/button";

/** Import/export controls for the canonical hardware `.hhhw` bundle. */
export function BundleActions({ kind, id, saved, onChanged }: {
  kind: DeviceBundleKind;
  id: string;
  saved: boolean;
  onChanged: (importedId: string) => Promise<void>;
}) {
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const act = useMutation({
    mutationFn: async (action: "export" | "import") =>
      action === "export" ? await window.hardwareharness.devices.exportBundle(kind, id) : await window.hardwareharness.devices.importBundle(kind),
    onSuccess: async (result) => {
      setError(undefined);
      if (!result) return;
      if ("path" in result) {
        setNotice(`已导出到 ${result.path}`);
        return;
      }
      setNotice(`已${result.replaced ? "覆盖" : "导入"} ${result.label}`);
      await onChanged(result.id);
    },
    onError: (value) => {
      setNotice(undefined);
      setError(errorMessage(value));
    }
  });

  return <div className="mr-auto flex flex-wrap items-center gap-2">
    <Button variant="ghost" size="sm" disabled={act.isPending} onClick={() => act.mutate("import")}><DownloadIcon />导入</Button>
    <Button
      variant="ghost"
      size="sm"
      disabled={!saved || act.isPending}
      title={saved ? "导出为单个 .hhhw 文件" : "保存后才能导出"}
      onClick={() => act.mutate("export")}
    ><CopyIcon />导出</Button>
    {notice && <span className="inline-flex max-w-80 items-center gap-1.5 text-xs leading-normal text-muted-foreground" role="status">{notice}</span>}
    {error && <span className="inline-flex max-w-80 items-center gap-1.5 text-xs leading-normal text-destructive" role="alert" title={error}><CircleAlertIcon className="size-3.5" />{error}</span>}
  </div>;
}
