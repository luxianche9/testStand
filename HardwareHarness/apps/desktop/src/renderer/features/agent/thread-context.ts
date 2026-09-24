import type { AssistantState, MessagePrimitive, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { createContext, type ComponentType, type PropsWithChildren, type ReactNode } from "react";

type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

export type ThreadComponents = {
  AssistantMessage?: ComponentType;
  Welcome?: ComponentType;
  Composer?: ReactNode;
  ToolFallback?: ToolCallMessagePartComponent;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>;
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>;
};

export const EMPTY_COMPONENTS: ThreadComponents = {};
export const ThreadComponentsContext = createContext(EMPTY_COMPONENTS);

export const isNewChatView = (state: AssistantState) =>
  state.thread.messages.length === 0 && (!state.thread.isLoading || state.threads.isLoading);
