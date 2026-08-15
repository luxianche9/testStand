import { describe, expect, it, vi } from "vitest";
import { DesktopEventHub } from "./desktop-events.js";

describe("DesktopEventHub", () => {
  it("drops events published before subscription and broadcasts later events", () => {
    const hub = new DesktopEventHub();
    const first = vi.fn();
    const second = vi.fn();

    hub.publish("project", { revision: 0 });
    const unsubscribeFirst = hub.subscribe("project", first);
    const unsubscribeSecond = hub.subscribe("project", second);
    hub.publish("project", { revision: 1 });
    unsubscribeFirst();
    hub.publish("project", { revision: 2 });
    unsubscribeSecond();

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ revision: 1 });
    expect(second).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenLastCalledWith({ revision: 2 });
  });
});
