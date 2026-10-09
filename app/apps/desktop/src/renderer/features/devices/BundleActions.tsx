import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DeviceBundleKind, DeviceBundlePreview } from "@teststand/contracts/devices";
import { CircleAlertIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { Button } from "../../ui";

/**
 * Picks a `.tshw` bundle and imports it, with no editor open around it. Returns undefined when the
 * file dialog is dismissed. This is the whole 导入被测件 / 夹具 path, so the 设备管理 「+」 menu and
 * the hardware editor's footer go through the same code.
 */
export async function importBundleFile(kind: DeviceBundleKind): Promise<string | undefined> {
  const { devices, dialogs } = window.teststand;
  const data = await dialogs.openBundle(kind);
  if (!data) return undefined;
  const result = await devices.importBundle({ data });
  return `已${result.replaced ? "覆盖" : "导入"} ${result.label}`;
}

/**
 * Import/export controls for the canonical hardware `.tshw` bundle.
 * With `onPreview` the import is staged (previewBundle) and the caller decides when to apply it;
 * otherwise the bundle is imported immediately and `onImported` runs after it lands.
 */
export function BundleActions({ kind, id, saved, disabled, exportTitle, onImported, onPreview }: {
  kind: DeviceBundleKind;
  id: string;
  saved: boolean;
  disabled?: boolean;
  exportTitle?: string;
  onImported?: () => Promise<void>;
  /** Receives a staged bundle and returns the notice to show; throw to reject it. */
  onPreview?: (preview: DeviceBundlePreview) => string;
}) {
  const [notice, setNotice] = useState<string>();
  const act = useMutation({
    mutationFn: async (action: "export" | "import"): Promise<string | undefined> => {
      const { devices, dialogs } = window.teststand;
      if (action === "export") {
        const hardwareId = id.trim();
        const result = await dialogs.saveBundle(kind, hardwareId, await devices.exportBundle({ hardwareId }));
        return result ? `已导出到 ${result.path}` : undefined;
      }
      if (!onPreview) {
        const message = await importBundleFile(kind);
        if (message) await onImported?.();
        return message;
      }
      const data = await dialogs.openBundle(kind);
      if (!data) return undefined;
      return onPreview({ kind, hardware: await devices.inspectBundle({ data }), data });
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
        title={saved ? (exportTitle ?? "导出为单个 .tshw 文件") : "保存后才能导出"}
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
