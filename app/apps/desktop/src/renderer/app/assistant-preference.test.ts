// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { ASSISTANT_OPEN_KEY, readAssistantOpen, writeAssistantOpen } from "./assistant-preference.js";

describe("assistant preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to closed", () => {
    expect(readAssistantOpen()).toBe(false);
  });

  it("persists both open and closed states", () => {
    writeAssistantOpen(true);
    expect(localStorage.getItem(ASSISTANT_OPEN_KEY)).toBe("true");
    expect(readAssistantOpen()).toBe(true);

    writeAssistantOpen(false);
    expect(localStorage.getItem(ASSISTANT_OPEN_KEY)).toBe("false");
    expect(readAssistantOpen()).toBe(false);
  });
});
