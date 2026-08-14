// @vitest-environment jsdom

import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  useLocalRuntime
} from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import "./test-dom";
import { Thread } from "./Thread";

const adapter: ChatModelAdapter = { async *run() {} };
const messages: ThreadMessageLike[] = [{
  role: "assistant",
  content: [
    { type: "text", text: "**加粗**\n\n| A | B |\n| - | - |\n| 1 | 2 |" },
    { type: "reasoning", text: "先检查工程，再执行测试。" },
    { type: "tool-call", toolCallId: "tool-1", toolName: "read", args: { file_path: "src/app.ts" }, argsText: "{\"file_path\":\"src/app.ts\"}", result: "ok" }
  ],
  status: { type: "complete", reason: "stop" }
}];

function Runtime() {
  const runtime = useLocalRuntime(adapter, { initialMessages: messages });
  return <AssistantRuntimeProvider runtime={runtime}><Thread /></AssistantRuntimeProvider>;
}

afterEach(cleanup);

describe("upstream-style thread rendering", () => {
  it("renders GFM Markdown, reasoning, and fallback tool details", async () => {
    render(<Runtime />);
    expect(await screen.findByText("加粗")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    expect(await screen.findByText("先检查工程，再执行测试。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /1 次工具调用/ }));
    await userEvent.click(screen.getByRole("button", { name: /已调用：read/ }));
    expect(await screen.findByText(/src\/app\.ts/)).toBeTruthy();
    expect(screen.getByText("ok")).toBeTruthy();
  });
});
