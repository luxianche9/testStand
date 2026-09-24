import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { WiringTaskModal } from "../features/wiring/WiringTaskPanel.js";
import { isTaskActionable } from "../features/wiring/wiring-model.js";
import { invalidateWiringData } from "../lib/mutations.js";

/** Pop each new wiring request once; a dismissed request stays in the wiring page's task sidebar. */
export function WiringTaskInbox({ tasks, hardware }: { tasks: WiringTask[]; hardware: Hardware[] }) {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const selected = tasks.find((task) => task.wiringTaskId === selectedId);
  useEffect(() => {
    if (selected) return;
    const next = tasks.find((task) => isTaskActionable(task) && !dismissed.has(task.wiringTaskId));
    setSelectedId(next?.wiringTaskId);
  }, [tasks, selected, dismissed]);
  const refresh = useCallback(async () => { await invalidateWiringData(client); }, [client]);
  const closeTask = () => {
    if (selectedId) setDismissed((current) => new Set(current).add(selectedId));
    setSelectedId(undefined);
  };
  if (!selected) return null;
  return (
    <WiringTaskModal
      key={selected.wiringTaskId}
      task={selected}
      hardware={hardware}
      onChanged={refresh}
      onClose={closeTask}
    />
  );
}
