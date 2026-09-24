import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DeviceBundleKind, DeviceBundlePreview } from "@hardwareharness/contracts/devices";
import { CircleAlertIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { errorMessage } from "../../../lib/errors.js";
import { Button } from "../../../ui";

/**
 * Import/export controls for the canonical hardware `.hhhw` bundle.
 * With `onPreview` the import is staged (previewBundle) and the caller decides when to apply it;
 * otherwise the bundle is imported immediately and `onImported` receives the stored id.
 */
export function BundleActions({ kind, id, saved, disabled, exportTitle, onImported, onPreview }: {
  kind: DeviceBundleKind;
  id: string;
  saved: boolean;
  disabled?: boolean;
  exportTitle?: string;
  onImported?: (importedId: string) => Promise<void>;
  /** Receives a staged bundle and returns the notice to show; throw to reject it. */
  onPreview?: (preview: DeviceBundlePreview) => string;
}) {
  const [notice, setNotice] = useState<string>();
  const act = useMutation({
    mutationFn: async (action: "export" | "import"): Promise<string | undefined> => {
      const devices = window.hardwareharness.devices;
      if (action === "export") {
        const result = await devices.exportBundle(kind, id.trim());
        return result ? `已导出到 ${result.path}` : undefined;
      }
      if (onPreview) {
        const preview = await devices.previewBundle(kind);
        return preview ? onPreview(preview) : undefined;
      }
      const result = await devices.importBundle(kind);
      if (!result) return undefined;
      await onImported?.(result.id);
      return `已${result.replaced ? "覆盖" : "导入"} ${result.label}`;
    },
    onMutate: () => setNotice(undefined),
    onSuccess: (message) => setNotice(message)
  });
  const busy = act.isPending || Boolean(disabled);
  return (
    <div className="mr-auto flex min-w-0 flex-wrap items-center gap-1.5">
      <Button variant="ghost" size="xs" disabled={busy} onClick={() => act.mutate("import")}>
        <DownloadIcon />导入
      </Button>
      <Button
        variant="ghost"
        size="xs"
        disabled={!saved || busy}
        title={saved ? (exportTitle ?? "导出为单个 .hhhw 文件") : "保存后才能导出"}
        onClick={() => act.mutate("export")}
      >
        <UploadIcon />导出
      </Button>
      {notice && <span role="status" className="max-w-80 truncate text-xs text-fg-2" title={notice}>{notice}</span>}
      {act.isError && (
        <span
          role="alert"
          className="inline-flex max-w-80 items-center gap-1.5 text-xs text-fail"
          title={errorMessage(act.error)}
        >
          <CircleAlertIcon className="size-3.5 flex-none" />
          <span className="truncate">{errorMessage(act.error)}</span>
        </span>
      )}
    </div>
  );
}
