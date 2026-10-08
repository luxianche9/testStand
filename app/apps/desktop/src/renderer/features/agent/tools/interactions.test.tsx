// @vitest-environment jsdom

import type { OpenCodePermissionRequest, OpenCodeQuestionRequest } from "@assistant-ui/react-opencode";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onSidePanelRequested } from "../../../lib/side-panel.js";
import { OpenCodePermissionCard } from "./PermissionCard";
import { OpenCodeQuestionCard } from "./QuestionCard";
import { getPatchInfo } from "./shared";
import { TestPlanTool } from "./test-plan-tool";

const replyToPermission = vi.fn(async () => undefined);
const replyToQuestion = vi.fn(async () => undefined);
const rejectQuestion = vi.fn(async () => undefined);

vi.mock("@assistant-ui/react-opencode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assistant-ui/react-opencode")>();
  return { ...actual, useOpenCodeRuntimeExtras: () => ({ replyToPermission, replyToQuestion, rejectQuestion }) };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("OpenCode interaction cards", () => {
  it("submits permission choices", async () => {
    const request = {
      id: "permission-1",
      permission: "bash",
      patterns: ["pnpm test"],
      toolName: "bash",
      toolInput: { command: "pnpm test" }
    } as unknown as OpenCodePermissionRequest;
    render(<OpenCodePermissionCard request={request} state="pending" />);
    await userEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(replyToPermission).toHaveBeenCalledWith("permission-1", "once");
  });

  it("renders and submits question answers", async () => {
    const request = {
      id: "question-1",
      questions: [{
        header: "执行方式",
        question: "选择测试范围",
        multiple: false,
        custom: true,
        options: [{ label: "全部", description: "运行完整测试" }]
      }]
    } as OpenCodeQuestionRequest;
    render(<OpenCodeQuestionCard request={request} state="pending" />);
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    await userEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(replyToQuestion).toHaveBeenCalledWith("question-1", [["全部"]]);
  });

  it("summarizes apply_patch files and line counts", () => {
    expect(getPatchInfo("*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch"))
      .toEqual({ files: ["a.ts"], added: 1, removed: 1 });
  });

  it("renders test plan revisions and opens the test panel", async () => {
    const navigate = vi.fn();
    const stop = onSidePanelRequested(navigate);
    render(
      <TestPlanTool
        type="tool-call"
        toolCallId="tool-1"
        toolName="apply_test_plan_operations"
        args={{}}
        argsText="{}"
        result={{ data: { plan: { id: "plan-1", name: "台架测试", revision: 4 }, appliedOperations: 2, issues: [] } }}
        status={{ type: "complete" }}
        addResult={vi.fn()}
        resume={vi.fn()}
        respondToApproval={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /修改测试流程/ }));
    expect(screen.getByText("台架测试")).toBeTruthy();
    expect(screen.getByText("rev 4")).toBeTruthy();
    expect(screen.getByText("修改 2 个节点")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "在测试面板查看" }));
    expect(navigate).toHaveBeenCalledWith("testing");
    stop();
  });
});
