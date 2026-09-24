import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import { CircleAlertIcon, ImageIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { Button } from "../../ui";
import { HardwareImage } from "./HardwareImage.js";

/** Appearance photo of the device as a whole; port photos are handled inside `PortEditor`. */
export function AppearanceImage({ hardwareId, assetId, saved, onChanged }: {
  hardwareId: string;
  assetId?: string | undefined;
  saved: boolean;
  onChanged: (hardware: Hardware) => void;
}) {
  const [error, setError] = useState<string>();
  const image = useMutation({
    mutationFn: async (action: "import" | "remove") => {
      const devices = window.hardwareharness.devices;
      return action === "import"
        ? await devices.importHardwareImage({ hardwareId })
        : await devices.removeHardwareImage({ hardwareId });
    },
    onSuccess: (hardware) => {
      setError(undefined);
      if (hardware) onChanged(hardware);
    },
    onError: (value) => setError(errorMessage(value))
  });
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2">
      <span className="tf-label w-14 flex-none">外观图</span>
      {assetId ? (
        <HardwareImage
          hardwareId={hardwareId}
          assetId={assetId}
          alt="外观图"
          className="h-16 max-h-16 rounded-sm border border-line bg-surface-0"
        />
      ) : (
        <span className="min-w-11 flex-none text-xs text-fg-3">未上传</span>
      )}
      <Button
        variant="ghost"
        size="xs"
        disabled={!saved || image.isPending}
        title={saved ? "上传或更换外观图" : "保存设备后可上传外观图"}
        onClick={() => image.mutate("import")}
      >
        <ImageIcon />{assetId ? "更换" : "上传"}
      </Button>
      {assetId && (
        <Button variant="ghost" size="xs" disabled={image.isPending} onClick={() => image.mutate("remove")}>移除</Button>
      )}
      {error && (
        <p role="alert" className="flex w-full items-start gap-2 text-xs break-words text-fail">
          <CircleAlertIcon className="mt-0.5 size-3.5 flex-none" />{error}
        </p>
      )}
    </div>
  );
}
