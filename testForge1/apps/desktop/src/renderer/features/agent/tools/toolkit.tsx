import { useAssistantToolUI } from "@assistant-ui/react";
import {
  ApplyPatchTool,
  AskQuestionTool,
  BashTool,
  EditTool,
  GlobTool,
  GrepTool,
  ReadTool,
  WebFetchTool,
  WebSearchTool,
  WriteTool
} from "./OpenCodeTools";

/**
 * OpenCode owns the tool definitions and execution lifecycle. These hooks only
 * teach assistant-ui how to render the tool-call parts returned by OpenCode,
 * so they work without assistant-ui's optional generative compiler.
 */
export function OpenCodeToolUIs() {
  useAssistantToolUI({ toolName: "read", render: ReadTool });
  useAssistantToolUI({ toolName: "edit", render: EditTool });
  useAssistantToolUI({ toolName: "write", render: WriteTool });
  useAssistantToolUI({ toolName: "bash", render: BashTool });
  useAssistantToolUI({ toolName: "grep", render: GrepTool });
  useAssistantToolUI({ toolName: "glob", render: GlobTool });
  useAssistantToolUI({ toolName: "webSearch", render: WebSearchTool });
  useAssistantToolUI({ toolName: "webFetch", render: WebFetchTool });
  useAssistantToolUI({ toolName: "apply_patch", render: ApplyPatchTool });
  useAssistantToolUI({ toolName: "ask_question", render: AskQuestionTool });
  useAssistantToolUI({ toolName: "request_user_input", render: AskQuestionTool });
  useAssistantToolUI({ toolName: "requestUserInput", render: AskQuestionTool });
  return null;
}
