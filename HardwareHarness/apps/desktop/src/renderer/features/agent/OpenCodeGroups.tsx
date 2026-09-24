import { useAuiState } from "@assistant-ui/react";
import { BrainIcon } from "lucide-react";
import { memo, type FC, type PropsWithChildren } from "react";
import { cn } from "../../ui";

type Group = { indices: readonly number[] };

type Parts = readonly { type: string }[];

function neighbourIsText(parts: Parts, from: number, step: 1 | -1) {
  for (let index = from; index >= 0 && index < parts.length; index += step) {
    const type = parts[index]?.type;
    if (type === "data") continue;
    return type === "text";
  }
  return false;
}

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
  const textAfter = useAuiState((state) => neighbourIsText(state.message.parts, end + 1, 1));
  return (
    <div
      className={cn(
        "mt-3 mb-2 flex items-start gap-2 text-sm leading-relaxed text-fg-3 first:mt-0",
        multiline && "mt-4 mb-3",
        textAfter && "mb-3"
      )}
    >
      <BrainIcon aria-hidden className="mt-[3px] size-3.5 shrink-0" />
      <div className="min-w-0 space-y-3 border-l border-line ps-3">{children}</div>
    </div>
  );
};
export const OpenCodeReasoningGroup = memo(ReasoningGroupImpl);

const ToolGroupImpl: FC<PropsWithChildren<{ group: Group }>> = ({ children, group }) => {
  const start = group.indices[0]!;
  const end = group.indices.at(-1)!;
  const textBefore = useAuiState((state) => neighbourIsText(state.message.parts, start - 1, -1));
  const textAfter = useAuiState((state) => neighbourIsText(state.message.parts, end + 1, 1));
  return <div className={cn("grid gap-1.5", textBefore && "mt-3", textAfter && "mb-3")}>{children}</div>;
};
export const OpenCodeToolGroup = memo(ToolGroupImpl);
