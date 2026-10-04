import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DevicePackageInspection, DeviceType, InstalledDevicePackage
} from "@teststand/contracts/devices";
import { CircleAlertIcon, PackagePlusIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, useConfirm } from "../../ui";

const actionLabels = { install: "安装", upgrade: "升级", reinstall: "重新安装" } as const;
const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/**
 * 设备类型: the device types this testStand can add, and the `.tsdev` device packages that bring
 * them. Installing runs the package's code in the backend, so the manifest is shown first and the
 * user confirms it. Upgrades and removals take effect when testStand starts again.
 */
export function DevicePackagesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const types = useQuery({
    queryKey: queryKeys.deviceTypes,
    queryFn: () => window.teststand.devices.listDeviceTypes(),
    enabled: open
  });
  const packages = useQuery({
    queryKey: queryKeys.devicePackages,
    queryFn: () => window.teststand.devices.listPackages(),
    enabled: open
  });
  const [staged, setStaged] = useState<{ data: Uint8Array; report: DevicePackageInspection }>();
  const [notice, setNotice] = useState<string>();
  const [confirm, confirmDialog] = useConfirm();
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.deviceTypes }),
    client.invalidateQueries({ queryKey: queryKeys.devicePackages })
  ]);

  const pick = useMutation({
    mutationFn: async () => {
      const data = await window.teststand.dialogs.openDevicePackage();
      if (!data) return undefined;
      return { data, report: await window.teststand.devices.inspectPackage({ data }) };
    },
    onMutate: () => setNotice(undefined),
    onSuccess: (result) => { if (result) setStaged(result); }
  });
  const install = useMutation({
    mutationFn: (data: Uint8Array) => window.teststand.devices.installPackage({ data }),
    onSuccess: async (result) => {
      setStaged(undefined);
      setNotice(result.restartRequired
        ? `${result.type} ${result.version ?? ""} 已安装，重启 testStand 后生效`
        : `${result.type} ${result.version ?? ""} 已安装，可以添加测试资源了`);
      await refresh();
    }
  });
  const uninstall = useMutation({
    mutationFn: (deviceType: string) => window.teststand.devices.uninstallPackage({ deviceType }),
    onSuccess: async (result) => {
      setNotice(`${result.type} 将在重启 testStand 后移除`);
      await refresh();
    }
  });

  const installed = new Map((packages.data ?? []).map((item) => [item.type, item]));
  const pending = (packages.data ?? []).some((item) => item.pending);
  const failure = pick.error ?? install.error ?? uninstall.error;
  const close = () => { setStaged(undefined); setNotice(undefined); onClose(); };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent title={staged ? "安装设备包" : "设备类型"} size="lg">
        {staged ? (
          <PackageReport report={staged.report} />
        ) : (
          <DialogBody className="grid gap-3">
            <p className="text-xs text-fg-3">
              每种设备由一个设备包（.tsdev）提供，装好后在“添加测试资源”里选择它的类型。
            </p>
            <TypeList types={types.data} installed={installed} loading={types.isPending}
              onUninstall={async (item) => {
                const ok = await confirm({
                  title: `卸载 ${item.type}`,
                  message: "使用该类型的测试资源将无法连接。卸载在重启 testStand 后生效。",
                  confirmLabel: "卸载",
                  danger: true
                });
                if (ok) uninstall.mutate(item.type);
              }}
            />
          </DialogBody>
        )}
        {(notice || failure) && (
          <div className="px-4 pb-2 text-xs">
            {notice && <p role="status" className="text-fg-2">{notice}</p>}
            {failure && (
              <p role="alert" className="flex items-center gap-1 text-fail">
                <CircleAlertIcon className="size-3.5" />{errorMessage(failure)}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          {staged ? (
            <>
              <Button onClick={() => setStaged(undefined)}>返回</Button>
              <Button
                variant="primary"
                disabled={install.isPending || staged.report.problems.length > 0}
                onClick={() => install.mutate(staged.data)}
              >
                {actionLabels[staged.report.action]}
              </Button>
            </>
          ) : (
            <>
              {pending && (
                <Button className="mr-auto" onClick={() => void window.teststand.window.relaunch()}>
                  <RotateCwIcon />重启 testStand
                </Button>
              )}
              <Button onClick={close}>关闭</Button>
              <Button variant="primary" disabled={pick.isPending} onClick={() => pick.mutate()}>
                <PackagePlusIcon />安装设备包…
              </Button>
            </>
          )}
        </DialogFooter>
        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
}

function TypeList({ types, installed, loading, onUninstall }: {
  types: DeviceType[] | undefined;
  installed: Map<string, InstalledDevicePackage>;
  loading: boolean;
  onUninstall: (item: InstalledDevicePackage) => void;
}) {
  // A package installed but not yet active (an upgrade of nothing, or a pending removal) is
  // still listed from the package records.
  const names = [...new Set([...(types ?? []).map((item) => item.type), ...installed.keys()])].sort();
  if (loading) return <p className="text-xs text-fg-3">读取中…</p>;
  if (names.length === 0) {
    return (
      <p className="rounded-sm border border-dashed border-line p-4 text-center text-xs text-fg-3">
        还没有设备类型。点“安装设备包…”选择一个 .tsdev 文件。
      </p>
    );
  }
  return (
    <ul className="grid gap-1.5" aria-label="已安装的设备类型">
      {names.map((name) => {
        const type = types?.find((item) => item.type === name);
        const item = installed.get(name);
        return (
          <li key={name} className="flex items-start gap-2 rounded-sm border border-line px-2.5 py-2 text-xs">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-fg">
                  {type?.manufacturer ?? item?.manufacturer} {type?.model ?? item?.model}
                </span>
                <span className="font-mono text-fg-3">{name}</span>
                <span className="text-fg-3">{type?.version ?? item?.version}</span>
                <Badge>{type?.source === "builtin" ? "内置" : "设备包"}</Badge>
                {item?.pending?.action === "install" && <Badge tone="signal">重启后升级到 {item.pending.version}</Badge>}
                {item?.pending?.action === "uninstall" && <Badge tone="signal">重启后移除</Badge>}
                {type?.error && <Badge tone="fail">不可用</Badge>}
              </div>
              {type?.error && <span className="break-words text-fail">{type.error}</span>}
              {item && item.vendorDrivers.length > 0 && (
                <span className="text-fg-3">需要厂商驱动：{item.vendorDrivers.join("、")}</span>
              )}
            </div>
            {item && item.pending?.action !== "uninstall" && (
              <Button size="xs" variant="ghost" aria-label={`卸载 ${name}`} onClick={() => onUninstall(item)}>
                <Trash2Icon />卸载
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The manifest the user confirms: what the package is, what it contains and what it needs. */
function PackageReport({ report }: { report: DevicePackageInspection }) {
  const { manifest } = report;
  const rows: [string, React.ReactNode][] = [
    ["设备", `${manifest.manufacturer} ${manifest.model}`],
    ["类型", <span className="font-mono">{manifest.type}</span>],
    ["版本", report.installedVersion ? `${report.installedVersion} → ${manifest.version}` : manifest.version],
    ["运行方式", manifest.isolation === "subprocess" ? "隔离子进程" : "后端进程内"],
    ["厂商驱动", manifest.vendorDrivers.length ? manifest.vendorDrivers.join("、") : "无"],
    ["设备包 SHA-256", <span className="break-all font-mono">{report.sha256}</span>],
    ["打包时间", manifest.builtAt ? new Date(manifest.builtAt).toLocaleString("zh-CN") : "—"]
  ];
  return (
    <DialogBody className="grid gap-3">
      {report.problems.length > 0 ? (
        <div role="alert" className="grid gap-1 rounded-sm border border-fail/40 bg-fail/5 p-2 text-xs text-fail">
          <span className="font-medium">无法安装：</span>
          <ul className="list-disc pl-4">{report.problems.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : (
        <p className="text-xs text-fg-2">
          设备包里的代码会在 testStand 后端里运行，可以调用驱动和读写文件。只安装来源可信的设备包。
          {report.restartRequired && " 该类型已在使用，新版本在重启 testStand 后生效。"}
        </p>
      )}
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-3">{label}</dt>
            <dd className="text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      {manifest.description && <p className="text-xs text-fg-2">{manifest.description}</p>}
      <table className="w-full text-xs" aria-label="设备包文件">
        <thead className="text-left text-fg-3">
          <tr>
            <th className="font-normal">文件</th>
            <th className="font-normal">大小</th>
            <th className="font-normal">SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {report.files.map((file) => (
            <tr key={file.name} className="align-top">
              <td className="break-all pr-2 font-mono">
                {file.name}{file.skipped && <span className="ml-1 text-fg-3">（testStand 已自带，跳过）</span>}
              </td>
              <td className="whitespace-nowrap pr-2">{size(file.size)}</td>
              <td className="break-all font-mono text-fg-3">{file.sha256.slice(0, 16)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DialogBody>
  );
}
