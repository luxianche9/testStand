import { useAuiState } from "@assistant-ui/react";
import { BrainIcon } from "lucide-react";
import { memo, type FC, type PropsWithChildren } from "react";
import { cn } from "../../shared/ui/index.js";

type Group = { indices: readonly number[] };

const ReasoningGroupImpl: FC<PropsWithChildren<{ group: Group }>> = ({ children, group }) => {
  const start = group.indices[0]!;
  const end = group.indices.at(-1)!;
  const multiline = useAuiState((state) => {
    let length = 0;
    for (let index = start; index <= end; index++) {
      const part = state.message.parts[index];
      if (part?.type === "reasoning") {
        if (part.text.includes("\n\n")) return true;
        length += part.text.length;
      }
    }
    return length > 120;
  });
  const textAfter = useAuiState((state) => {
    for (let index = end + 1; index < state.message.parts.length; index++) {
      const type = state.message.parts[index]?.type;
      if (type === "data") continue;
      return type === "text";
    }
    return false;
  });
  return <div className={cn("mt-4 mb-2 flex items-start gap-2 text-sm leading-relaxed text-muted-foreground first:mt-0", multiline && "mt-6 mb-4", textAfter && "mb-4")}><BrainIcon className="mt-[3px] size-3.5 shrink-0" /><div className="space-y-4">{children}</div></div>;
};
export const OpenCodeReasoningGroup = memo(ReasoningGroupImpl);

const ToolGroupImpl: FC<PropsWithChildren<{ group: Group }>> = ({ children, group }) => {
  const start = group.indices[0]!;
  const end = group.indices.at(-1)!;
  const textBefore = useAuiState((state) => {
    for (let index = start - 1; index >= 0; index--) { const type = state.message.parts[index]?.type; if (type === "data") continue; return type === "text"; }
    return false;
  });
  const textAfter = useAuiState((state) => {
    for (let index = end + 1; index < state.message.parts.length; index++) { const type = state.message.parts[index]?.type; if (type === "data") continue; return type === "text"; }
    return false;
  });
  return <div className={cn(textBefore && "mt-4", textAfter && "mb-4")}>{children}</div>;
};
export const OpenCodeToolGroup = memo(ToolGroupImpl);
