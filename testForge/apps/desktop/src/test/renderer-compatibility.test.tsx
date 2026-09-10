import { describe, expect, it } from "vitest";
import { occupancyTone } from "../renderer/app/MailboxDropdown.js";
import { formatDuration } from "../renderer/features/logs/logs-model.js";

describe("renderer formatting remains compatible with backend records", () => {
  it("preserves every occupancy status tone", () => {
    expect(["pending", "confirmed", "rejected", "failed", "timed_out", "cancelled"].map(
      (status) => occupancyTone(status as Parameters<typeof occupancyTone>[0])
    )).toEqual(["warn", "ok", "bad", "bad", "bad", "muted"]);
  });

  it("preserves run duration boundary formatting", () => {
    expect([0, 999, 1000, 59999, 60000, 125999].map(formatDuration)).toEqual([
      "0 ms", "999 ms", "1.00 s", "60.00 s", "1m 0s", "2m 5s"
    ]);
  });
});
