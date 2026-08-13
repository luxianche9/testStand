// @vitest-environment jsdom

import type { OpenCodePermissionRequest, OpenCodeQuestionRequest } from "@assistant-ui/react-opencode";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodePermissionCard } from "./PermissionCard";
import { OpenCodeQuestionCard } from "./QuestionCard";
import { getPatchInfo } from "./shared";

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
    const request = { id: "permission-1", permission: "bash", patterns: ["pnpm test"], toolName: "bash", toolInput: { command: "pnpm test" } } as unknown as OpenCodePermissionRequest;
    render(<OpenCodePermissionCard request={request} state="pending" />);
    await userEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(replyToPermission).toHaveBeenCalledWith("permission-1", "once");
  });

  it("renders and submits question answers", async () => {
    const request = { id: "question-1", questions: [{ header: "执行方式", question: "选择测试范围", multiple: false, custom: true, options: [{ label: "全部", description: "运行完整测试" }] }] } as OpenCodeQuestionRequest;
    render(<OpenCodeQuestionCard request={request} state="pending" />);
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    await userEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(replyToQuestion).toHaveBeenCalledWith("question-1", [["全部"]]);
  });

  it("summarizes apply_patch files and line counts", () => {
    expect(getPatchInfo("*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch")).toEqual({ files: ["a.ts"], added: 1, removed: 1 });
  });
});
