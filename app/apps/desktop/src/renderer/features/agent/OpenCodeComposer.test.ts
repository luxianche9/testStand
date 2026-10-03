import { describe, expect, it } from "vitest";
import {
  filterOpenCodeCommands,
  parseOpenCodeCommand,
  serializeOpenCodeCommandAttachments,
  type OpenCodeCommandOption
} from "./OpenCodeComposer";

const commands: OpenCodeCommandOption[] = [
  { name: "review", description: "Review the current changes" },
  { name: "test", description: "Run focused tests" },
  { name: "release", description: "Prepare a release" }
];

describe("OpenCode command composer", () => {
  it("recognizes only registered slash commands and preserves arguments", () => {
    expect(parseOpenCodeCommand("/review src/app.ts --strict", commands)).toEqual({
      name: "review",
      arguments: "src/app.ts --strict"
    });
    expect(parseOpenCodeCommand("/missing value", commands)).toBeUndefined();
    expect(parseOpenCodeCommand("review value", commands)).toBeUndefined();
  });

  it("filters commands by name or description and respects the result limit", () => {
    expect(filterOpenCodeCommands(commands, "focus").map((command) => command.name)).toEqual(["test"]);
    expect(filterOpenCodeCommands(commands, "re", 1).map((command) => command.name)).toEqual(["review"]);
  });

  it("serializes complete image and file attachments for session.command", () => {
    expect(serializeOpenCodeCommandAttachments([
      {
        id: "image-1",
        type: "image",
        name: "scope.png",
        contentType: "image/png",
        status: { type: "complete" },
        content: [{ type: "image", image: "data:image/png;base64,AA==" }]
      },
      {
        id: "file-1",
        type: "file",
        name: "notes.txt",
        contentType: "text/plain",
        status: { type: "complete" },
        content: [{ type: "file", data: "data:text/plain;base64,SGk=", mimeType: "text/plain", filename: "notes.txt" }]
      }
    ])).toEqual([
      { type: "file", mime: "image/png", filename: "scope.png", url: "data:image/png;base64,AA==" },
      { type: "file", mime: "text/plain", filename: "notes.txt", url: "data:text/plain;base64,SGk=" }
    ]);
  });
});
