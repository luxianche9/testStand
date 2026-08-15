import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware } from "@testforge/contracts/devices";
import type { WiringTask } from "@testforge/contracts/wiring";
import { errorMessage } from "../../shared/errors.js";
import { IconAlert } from "../../shared/icons.js";
import { Badge, Btn, Modal } from "../../shared/ui.js";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { assetKey, taskTitle } from "./wiring-model.js";

export function WiringTaskModal({ task, hardware, assetUrls, onAssetUrl, onChanged }: {
  task: WiringTask; hardware: Hardware[];
  assetUrls: Record<string, string>; onAssetUrl: (key: string, url: string) => void; onChanged: () => Promise<void>;
}) {
  const start = useMutation({
    mutationFn: () => window.testforge.wiring.startTask(task.wiringTaskId, "operator"),
    onSuccess: async () => { await onChanged(); }
  });
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") => window.testforge.wiring.completeTask(task.wiringTaskId, outcome),
    onSuccess: async () => { await onChanged(); }
  });
  const a = resolvePortRef(task.portA, hardware);
  const b = resolvePortRef(task.portB, hardware);
  const pending = task.status === "pending";
  const busy = start.isPending || complete.isPending;
  return <Modal
    open
    title={pending
      ? task.action === "connect" ? "待处理人工接线任务" : "待处理人工断线任务"
      : task.action === "connect" ? "人工接线任务" : "人工断线任务"}
    width={880}
    footer={pending
      ? <Btn variant="primary" onClick={() => start.mutate()} disabled={busy}>开始处理</Btn>
      : <>
        <Btn onClick={() => complete.mutate("rejected")} disabled={busy}>无法完成</Btn>
        <Btn variant="primary" onClick={() => complete.mutate("confirmed")} disabled={busy}>已完成</Btn>
      </>}
  >
    <div className="task-instruction">
      <Badge tone="warn">{pending ? "等待开始" : "硬件已独占"}</Badge>
      <strong>{taskTitle(task, hardware)}</strong>
      <Countdown expiresAt={task.expiresAt} />
    </div>
    {task.warnings.length > 0 && <div className="alert"><IconAlert size={15} /><span>{task.warnings.join("；")}</span></div>}
    <div className="task-port-images">
      <PortGuide portRef={task.portA} hardware={hardware} assetUrls={assetUrls} onAssetUrl={onAssetUrl} />
      <div className="task-port-arrow">→</div>
      <PortGuide portRef={task.portB} hardware={hardware} assetUrls={assetUrls} onAssetUrl={onAssetUrl} />
    </div>
    {task.pins.length > 0 && (
      <div className="task-pin-table">
        <header><span>需要连接的针脚</span><strong>{task.pins.length}</strong></header>
        {task.pins.map((pin) => <div key={`${pin.a}-${pin.b}`}>
          <span>{pinText(a.port, pin.a)}</span>
          <i>→</i>
          <span>{pinText(b.port, pin.b)}</span>
        </div>)}
      </div>
    )}
    <p className="task-note">
      {task.pins.length > 0
        ? "请按照端口图片上的针脚编号，逐条完成上表中的物理接线。确认「已完成」后，工程接线文档才会更新。"
        : "两端都没有登记针脚，按整个端口完成物理连接即可。确认「已完成」后，工程接线文档才会更新。"}
    </p>
    {(start.isError || complete.isError) && <div className="alert"><IconAlert size={15} /><span>{errorMessage(start.error ?? complete.error)}</span></div>}
  </Modal>;
}

function PortGuide({ portRef, hardware, assetUrls, onAssetUrl }: {
  portRef: string; hardware: Hardware[];
  assetUrls: Record<string, string>; onAssetUrl: (key: string, url: string) => void;
}) {
  const { hardware: owner, port } = resolvePortRef(portRef, hardware);
  const assetId = port?.imageAssetId;
  const key = owner && assetId ? assetKey(owner.hardwareId, assetId) : undefined;
  useEffect(() => {
    if (!owner || !assetId || !key || assetUrls[key] !== undefined) return;
    void window.testforge.devices.hardwareImageUrl(owner.hardwareId, assetId).then((url) => onAssetUrl(key, url));
  }, [assetId, assetUrls, key, onAssetUrl, owner]);
  const url = key ? assetUrls[key] : undefined;
  return <article className="task-port-guide">
    <header>
      <strong>{owner?.label ?? "未解析设备"}</strong>
      <span>{port?.name ?? "未知端口"}{port ? `，${port.pins.length ? `${port.pins.length} 针` : "无针脚"}` : ""}</span>
    </header>
    <div>{url ? <img src={url} alt={`${owner?.label ?? "硬件"} ${port?.name ?? "端口"}`} /> : <span>未上传端口图，请按针脚编号操作</span>}</div>
    <code>{portRef}</code>
  </article>;
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return <code>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</code>;
}

/* --------------------------------- 辅助 --------------------------------- */
