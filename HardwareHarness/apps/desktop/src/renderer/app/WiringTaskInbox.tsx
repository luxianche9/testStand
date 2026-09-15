import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { WiringTaskModal } from "../features/wiring/WiringTaskPanel.js";
import { isTaskActionable } from "../features/wiring/wiring-model.js";
import { invalidateWiringData } from "../shared/mutations.js";
import { MailboxDropdown } from "./MailboxDropdown.js";

/** Keep dismissed requests in the inbox and retain completed details until explicitly closed. */
export function WiringTaskInbox({ tasks, hardware, mailboxOpen, onCloseMailbox }: {
  tasks: WiringTask[]; hardware: Hardware[]; mailboxOpen: boolean; onCloseMailbox: () => void;
}) {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const selected = tasks.find((task) => task.wiringTaskId === selectedId);
  useEffect(() => {
    if (selected || mailboxOpen) return;
    const next = tasks.find((task) => isTaskActionable(task) && !dismissed.has(task.wiringTaskId));
    setSelectedId(next?.wiringTaskId);
  }, [tasks, selected, dismissed, mailboxOpen]);
  const refresh = useCallback(async () => { await invalidateWiringData(client); }, [client]);
  const closeTask = () => {
    if (selectedId) setDismissed((current) => new Set(current).add(selectedId));
    setSelectedId(undefined);
  };
  return <>
    {mailboxOpen && <MailboxDropdown tasks={tasks} hardware={hardware} onClose={onCloseMailbox} onOpenTask={(task) => { setSelectedId(task.wiringTaskId); onCloseMailbox(); }} />}
    {!mailboxOpen && selected && <WiringTaskModal key={selected.wiringTaskId} task={selected} hardware={hardware} onChanged={refresh} onClose={closeTask} />}
  </>;
}
