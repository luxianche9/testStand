import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DeviceAdded, DevicePackageInspection } from "@teststand/contracts/devices";
import { RotateCwIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input, Select } from "../../ui";
import { EditorField } from "./editors/EditorField.js";

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/** A `.tsdev` file the user picked, with what adding it would install. */
export type StagedPackage = { data: Uint8Array; report: DevicePackageInspection };

/** Picks a `.tsdev` file and reads its manifest; undefined when the user cancels. */
export async function pickDevicePackage(): Promise<StagedPackage | undefined> {
  const data = await window.teststand.dialogs.openDevicePackage();
  if (!data) return undefined;
  return { data, report: await window.teststand.devices.inspectPackage({ data }) };
}

/**
 * 添加设备: a device is added from its device package (`.tsdev`). The package's code runs in the
 * backend, so what it is and what it contains is shown first; the user names the device, chooses
 * real or simulated, and adds it. The device is connected straight away.
 */
export function AddDeviceDialog({ staged, onClose, onAdded }: {
  staged: StagedPackage | undefined;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  return (
    <Dialog open={Boolean(staged)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {staged && (
        <DialogContent title="添加设备" size="lg">
          <AddDevice key={staged.report.sha256} staged={staged} onClose={onClose} onAdded={onAdded} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function AddDevice({ staged, onClose, onAdded }: {
  staged: StagedPackage;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const { report } = staged;
  const { manifest } = report;
  const [label, setLabel] = useState(manifest.model);
  const [mode, setMode] = useState<"real" | "sim">("real");
  const [added, setAdded] = useState<DeviceAdded>();
  const add = useMutation({
    mutationFn: () => window.teststand.devices.addDevice({ data: staged.data, label, mode }),
    onSuccess: async (result) => {
      await onAdded();
      if (result.restartRequired) setAdded(result);
      else onClose();
    }
  });

  if (added) {
    return (
      <>
        <DialogBody>
          <p role="status" className="text-sm text-fg-2">
            已添加 {added.device.label}。它使用的驱动比已加载的版本新，重启 testStand 后生效。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>稍后</Button>
          <Button variant="primary" onClick={() => void window.teststand.window.relaunch()}>
            <RotateCwIcon />重启 testStand
          </Button>
        </DialogFooter>
      </>
    );
  }

  const rows: [string, React.ReactNode][] = [
    ["设备", `${manifest.manufacturer} ${manifest.model}`],
    ["驱动版本", report.installedVersion && report.action !== "present"
      ? `${report.installedVersion} → ${manifest.version}` : manifest.version],
    ["需要的厂商驱动", manifest.vendorDrivers.length ? manifest.vendorDrivers.join("、") : "无"],
    ["设备包 SHA-256", <span className="break-all font-mono">{report.sha256}</span>]
  ];
  return (
    <>
      <DialogBody className="grid gap-3">
        {report.problems.length > 0 ? (
          <div role="alert" className="grid gap-1 rounded-sm border border-fail/40 bg-fail/5 p-2 text-xs text-fail">
            <span className="font-medium">无法添加：</span>
            <ul className="list-disc pl-4">{report.problems.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        ) : report.action !== "present" && (
          <p className="text-xs text-fg-2">
            设备包里的驱动代码会在 testStand 里运行，可以调用厂商驱动和读写文件。只添加来源可信的设备包。
          </p>
        )}
        {manifest.description && <p className="text-xs text-fg-2">{manifest.description}</p>}
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-fg-3">{name}</dt>
              <dd className="text-fg">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="grid grid-cols-2 gap-3">
          <EditorField label="名称">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </EditorField>
          <EditorField label="运行模式">
            <Select value={mode} onChange={(event) => setMode(event.target.value as "real" | "sim")}>
              <option value="real">实物（驱动真实硬件）</option>
              <option value="sim">模拟（不接硬件）</option>
            </Select>
          </EditorField>
        </div>
        <details className="text-xs text-fg-3">
          <summary className="cursor-pointer select-none">设备包文件</summary>
          <ul className="mt-1 grid gap-0.5" aria-label="设备包文件">
            {report.files.map((file) => (
              <li key={file.name} className="flex gap-2">
                <span className="min-w-0 flex-1 break-all font-mono">{file.name}</span>
                <span>{size(file.size)}</span>
                <span className="font-mono">{file.sha256.slice(0, 12)}…</span>
              </li>
            ))}
          </ul>
        </details>
        {add.isError && <p role="alert" className="text-xs text-fail">{errorMessage(add.error)}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={add.isPending || report.problems.length > 0} onClick={() => add.mutate()}>
          {add.isPending ? "正在连接…" : "添加"}
        </Button>
      </DialogFooter>
    </>
  );
}
