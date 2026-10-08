// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceBindingsEditor, nextBindingName } from "./DeviceBindings.js";

afterEach(cleanup);

describe("DeviceBindingsEditor", () => {
  it("edits bindings in place and drops an empty stream", () => {
    const onChange = vi.fn();
    const value = { psu: { hardwareId: "PC1.PSU_${station}" }, uart: { hardwareId: "PC1.CARD", streamId: "serial1" } };
    render(<DeviceBindingsEditor value={value} hardware={[]} onChange={onChange} />);

    const uart = screen.getByRole("group", { name: "设备绑定 uart" });
    fireEvent.change(uart.querySelector("[aria-label='数据流']")!, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ psu: value.psu, uart: { hardwareId: "PC1.CARD" } });

    const psu = screen.getByRole("group", { name: "设备绑定 psu" });
    fireEvent.change(psu.querySelector("[aria-label='绑定名']")!, { target: { value: "uart" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.change(psu.querySelector("[aria-label='绑定名']")!, { target: { value: "psu_main" } });
    expect(Object.keys(onChange.mock.lastCall![0] as object)).toEqual(["psu_main", "uart"]);

    fireEvent.click(screen.getByRole("button", { name: "添加设备绑定" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, dev1: { hardwareId: "" } });
  });

  it("names new bindings", () => {
    expect(nextBindingName({ dev1: { hardwareId: "a" } })).toBe("dev2");
  });
});
