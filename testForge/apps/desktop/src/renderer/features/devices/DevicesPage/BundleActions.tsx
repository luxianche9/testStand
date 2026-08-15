import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DeviceBundleKind } from "@testforge/contracts/devices";
import { errorMessage } from "../../../shared/errors.js";
import { IconAlert, IconCopy, IconDownload } from "../../../shared/icons.js";
import { Btn } from "../../../shared/ui.js";

/** Import/export controls for the canonical hardware `.tfhw` bundle. */
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
      action === "export" ? await window.testforge.devices.exportBundle(kind, id) : await window.testforge.devices.importBundle(kind),
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

  return <div className="bundle-actions">
    <Btn variant="subtle" icon={<IconDownload size={14} />} disabled={act.isPending} onClick={() => act.mutate("import")}>导入</Btn>
    <Btn
      variant="subtle"
      icon={<IconCopy size={14} />}
      disabled={!saved || act.isPending}
      title={saved ? "导出为单个 .tfhw 文件" : "保存后才能导出"}
      onClick={() => act.mutate("export")}
    >导出</Btn>
    {notice && <span className="library-notice" role="status">{notice}</span>}
    {error && <span className="library-notice error" role="alert" title={error}><IconAlert size={14} />{error}</span>}
  </div>;
}
