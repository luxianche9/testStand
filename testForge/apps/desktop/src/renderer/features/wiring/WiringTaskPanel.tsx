import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware } from "@testforge/contracts/devices";
import type { WiringTask } from "@testforge/contracts/wiring";
import { IconAlert } from "../../shared/icons.js";
import { Badge, Btn, Modal } from "../../shared/ui.js";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { assetKey, taskTitle } from "./wiring-model.js";

export function WiringTaskModal({ task, hardware, assetUrls, onAssetUrl, onChanged }: {
  task: WiringTask; hardware: Hardware[];
  assetUrls: Record<string, string>; onAssetUrl: (key: string, url: string) => void; onChanged: () => Promise<void>;
}) {
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") => window.testforge.wiring.completeTask(task.wiringTaskId, outcome),
    onSuccess: async () => { await onChanged(); }
  });
  const a = resolvePortRef(task.portA, hardware);
  const b = resolvePortRef(task.portB, hardware);
  return <Modal
    open
    onClose={() => undefined}
    title={task.action === "connect" ? "人工接线任务" : "人工断线任务"}
    width={880}
    footer={<>
      <Btn onClick={() => complete.mutate("rejected")} disabled={complete.isPending}>无法完成</Btn>
      <Btn variant="primary" onClick={() => complete.mutate("confirmed")} disabled={complete.isPending}>已完成</Btn>
    </>}
  >
    <div className="task-instruction">
      <Badge tone="warn">硬件已独占</Badge>
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
    {complete.isError && <div className="alert"><IconAlert size={15} /><span>{String(complete.error)}</span></div>}
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
